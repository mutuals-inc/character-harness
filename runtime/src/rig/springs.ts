// A VRM's spring bones (hair, skirts and the like that swing as the character moves),
// read from either VRM version into one plain list the player turns into its
// own cloth (player/src/app/player_vrm.c). It goes in the prepared file's
// `extras.mutualsHarness.springs`:
//
//   [{ bones, roots, stiffness, gravity, gravity_dir, drag, radius, colliders }]
//
// - bones: the nodes that swing, each chain from its root down; roots: the
//   ones that stay attached to the body (the first of each chain)
// - stiffness, gravity, drag, radius: VRM's own values (stiffness 0..4,
//   gravity power, drag 0..1, hit radius in metres)
// - colliders: [{ node, radius, offset, tail? }] spheres, or capsules when
//   there's a tail, in the node's own space
//
// VRM 1.0 keeps them in VRMC_springBone, one chain per spring; VRM 0.x in
// secondaryAnimation, one group per set of roots with everything below them.
// A VRM 0.x model has been turned to face +Z (normalize.ts), so its collider
// offsets and gravity turn with it. Every node a spring or collider uses joins the
// skin, so the player finds it among the model's joints.

import { addAccessor, readAccessor, type Glb } from "./glb.ts";
import { minv, mmul, type Mat4, type Vec3 } from "./math.ts";
import type { Humanoid } from "./humanoid.ts";

export interface SpringCollider {
	node: number;
	radius: number;
	offset: Vec3;
	tail?: Vec3;
}

export interface Spring {
	bones: number[];
	roots: number[];
	stiffness: number;
	gravity: number;
	gravity_dir: Vec3;
	drag: number;
	radius: number;
	colliders: SpringCollider[];
}

// the player simulates at most this many chains per model; more are left out
export const MAX_SPRINGS = 24;
// a chain past this many bones, or a model past this many in all, is cut
const MAX_BONES = 256;
const MAX_TOTAL_BONES = 2048;
const MAX_COLLIDERS = 64;
// colliders one model may use in all
const MAX_TOTAL_COLLIDERS = 256;
// entries read from any one list in the file (springs, groups, colliders)
const MAX_LISTED = 4096;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number, lo: number, hi: number) =>
	typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const vec = (v: unknown, fallback: Vec3): Vec3 => {
	// VRM 1.0 writes [x, y, z], VRM 0.x { x, y, z }
	const a = Array.isArray(v) ? v : isObj(v) ? [v.x, v.y, v.z] : null;
	return a && a.length === 3 && a.every((x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) < 1e3)
		? (a as Vec3)
		: fallback;
};
const DOWN: Vec3 = [0, -1, 0];
// the 180-degree turn about Y the model got (normalize.ts turnV0)
const turn = (v: Vec3): Vec3 => [-v[0], v[1], -v[2]];
// VRM 0.x writes collider offsets with z pointing the other way (as
// three-vrm reads them), so their z is flipped before the turn; gravity is
// written as it is
const v0Offset = (v: Vec3, turned: boolean): Vec3 => {
	const fixed: Vec3 = [v[0], v[1], -v[2]];
	return turned ? turn(fixed) : fixed;
};

// The model's springs, or none. `turned` says whether a VRM 0.x model was
// turned to face +Z. The limits apply while reading, so a file can't make it
// build more than the player takes: at most MAX_SPRINGS chains (the rest are
// left out), MAX_BONES bones a chain and MAX_TOTAL_BONES in all, each bone in
// one chain only, MAX_COLLIDERS colliders a chain and MAX_TOTAL_COLLIDERS in
// all.
export function readSprings(glb: Glb, turned: boolean): Spring[] {
	const json = glb.json;
	const nodes = Array.isArray(json.nodes) ? json.nodes : [];
	const isNode = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < nodes.length;
	const ext = isObj(json.extensions) ? json.extensions : {};
	const springs: Spring[] = [];
	const taken = new Set<number>(); // bones already in a chain
	let total = 0;
	let colliderRoom = MAX_TOTAL_COLLIDERS;
	const room = () => springs.length < MAX_SPRINGS && total < MAX_TOTAL_BONES;
	// a chain's bones, cut to what's left and to bones no other chain has
	const claim = (wanted: number[], roots: number[]): { bones: number[]; roots: number[] } | null => {
		const bones: number[] = [];
		for (const b of wanted) {
			if (bones.length >= MAX_BONES || total + bones.length >= MAX_TOTAL_BONES) break;
			if (!taken.has(b)) bones.push(b);
		}
		const mine = new Set(bones);
		const kept = roots.filter((r) => mine.has(r));
		// a chain with nothing left to swing, or that lost its root, is dropped
		if (bones.length < 2 || !kept.length) return null;
		for (const b of bones) taken.add(b);
		total += bones.length;
		return { bones, roots: kept };
	};
	// the colliders of the groups named, each group once, up to MAX_COLLIDERS
	const collidersOf = (named: unknown, groups: SpringCollider[][]): SpringCollider[] => {
		const out: SpringCollider[] = [];
		const seen = new Set<number>();
		for (const g of Array.isArray(named) ? named : []) {
			if (!Number.isInteger(g) || seen.has(g as number) || !groups[g as number]) continue;
			seen.add(g as number);
			for (const c of groups[g as number]) {
				if (out.length >= MAX_COLLIDERS || !colliderRoom) return out;
				if (!out.includes(c)) {
					out.push(c);
					colliderRoom--;
				}
			}
		}
		return out;
	};
	const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

	if (isObj(ext.VRMC_springBone)) {
		const sb = ext.VRMC_springBone;
		const colliders = list(sb.colliders, MAX_LISTED).map((c): SpringCollider | null => {
			if (!isObj(c) || !isNode(c.node) || !isObj(c.shape)) return null;
			const sphere = isObj(c.shape.sphere) ? c.shape.sphere : null;
			const capsule = isObj(c.shape.capsule) ? c.shape.capsule : null;
			const s = sphere ?? capsule;
			if (!s) return null;
			const out: SpringCollider = { node: c.node, radius: num(s.radius, 0, 0, 10), offset: vec(s.offset, [0, 0, 0]) };
			if (capsule) out.tail = vec(capsule.tail, out.offset);
			return out;
		});
		const groups = list(sb.colliderGroups, MAX_LISTED).map((g) => {
			const out: SpringCollider[] = [];
			for (const i of isObj(g) ? list(g.colliders, MAX_COLLIDERS) : []) {
				const c = Number.isInteger(i) ? colliders[i as number] : null;
				if (c && !out.includes(c)) out.push(c);
			}
			return out;
		});
		for (const s of list(sb.springs, MAX_LISTED)) {
			if (!room()) break;
			if (!isObj(s)) continue;
			const joints = list(s.joints, MAX_BONES).filter((j): j is Obj => isObj(j) && isNode(j.node));
			if (joints.length < 2) continue;
			// a joint's settings move the segment below it, so the last one's are unused
			const first = joints[0];
			const chain = claim(joints.map((j) => j.node as number), [first.node as number]);
			if (!chain) continue;
			springs.push({
				...chain,
				stiffness: num(first.stiffness, 1, 0, 4),
				gravity: num(first.gravityPower, 0, 0, 2),
				gravity_dir: vec(first.gravityDir, DOWN),
				drag: num(first.dragForce, 0.5, 0, 1),
				radius: num(first.hitRadius, 0, 0, 1),
				colliders: collidersOf(s.colliderGroups, groups),
			});
		}
	} else if (isObj(ext.VRM) && isObj(ext.VRM.secondaryAnimation)) {
		const sa = ext.VRM.secondaryAnimation;
		const groups = list(sa.colliderGroups, MAX_LISTED).map((g) =>
			isObj(g) && isNode(g.node)
				? list(g.colliders, MAX_COLLIDERS)
						.filter(isObj)
						.map((c) => ({
							node: g.node as number,
							radius: num(c.radius, 0, 0, 10),
							offset: v0Offset(vec(c.offset, [0, 0, 0]), turned),
						}))
				: [],
		);
		for (const g of list(sa.boneGroups, MAX_LISTED)) {
			if (!room()) break;
			if (!isObj(g)) continue;
			const roots = [...new Set(list(g.bones, MAX_BONES).filter(isNode))];
			// each root and everything below it, parents first; a node reached twice
			// (or through a loop) is taken once
			const bones: number[] = [];
			const seen = new Set<number>();
			const stack = [...roots].reverse();
			while (stack.length && bones.length < MAX_BONES) {
				const n = stack.pop()!;
				if (seen.has(n)) continue;
				seen.add(n);
				bones.push(n);
				const c = nodes[n]?.children;
				if (Array.isArray(c))
					for (let i = Math.min(c.length, MAX_BONES) - 1; i >= 0; i--) if (isNode(c[i])) stack.push(c[i]);
			}
			const chain = claim(bones, roots);
			if (!chain) continue;
			springs.push({
				...chain,
				// VRM 0.x spells it "stiffiness"
				stiffness: num(g.stiffiness ?? g.stiffness, 1, 0, 4),
				gravity: num(g.gravityPower, 0, 0, 2),
				gravity_dir: turned ? turn(vec(g.gravityDir, DOWN)) : vec(g.gravityDir, DOWN),
				drag: num(g.dragForce, 0.5, 0, 1),
				radius: num(g.hitRadius, 0, 0, 1),
				colliders: collidersOf(g.colliderGroups, groups),
			});
		}
	}
	return springs;
}

// Every node the springs use joins the model's (single, merged) skin, so the
// player finds it among the model's joints. A node no vertex follows is bound
// as it hangs from its nearest joint above, in that joint's bind pose, so the
// bind pose stays one consistent skeleton. Returns how many joined.
export function addSpringJoints(glb: Glb, springs: Spring[], model: Humanoid): number {
	const skin = Array.isArray(glb.json.skins) ? (glb.json.skins[0] as { joints?: number[]; inverseBindMatrices?: number } | undefined) : undefined;
	if (!skin || !Array.isArray(skin.joints)) return 0;
	const have = new Set(skin.joints);
	const want = new Set<number>();
	for (const s of springs) {
		for (const b of s.bones) want.add(b);
		for (const c of s.colliders) want.add(c.node);
	}
	// parents first, so each joins after the joint it hangs from
	const depth = new Map<number, number>();
	for (const n of want) {
		let d = 0;
		for (let p = model.parent[n]; p >= 0 && d < 10_000; p = model.parent[p]) d++;
		depth.set(n, d);
	}
	const missing = [...want].filter((n) => !have.has(n) && model.world[n]).sort((a, b) => depth.get(a)! - depth.get(b)!);
	if (!missing.length) return 0;
	// one matrix per joint, as glTF wants: a longer list is cut, a shorter one
	// filled with identities, so the new ones line up with the joints they bind
	const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
	const read = skin.inverseBindMatrices === undefined ? [] : Array.from(readAccessor(glb, skin.inverseBindMatrices));
	const ibm: number[] = [];
	for (let j = 0; j < skin.joints.length; j++) ibm.push(...(read.length >= (j + 1) * 16 ? read.slice(j * 16, j * 16 + 16) : identity));
	const bindOf = new Map<number, Mat4>(skin.joints.map((n, j) => [n, ibm.slice(j * 16, j * 16 + 16)]));
	const added: number[] = [];
	for (const n of missing) {
		let p = model.parent[n];
		for (let d = 0; p >= 0 && !bindOf.has(p) && d < 10_000; d++) p = model.parent[p];
		// inverse bind = inverse(world_n) * world_p * inverse bind_p
		const m = p >= 0 ? mmul(mmul(minv(model.world[n]), model.world[p]), bindOf.get(p)!) : minv(model.world[n]);
		// a node scaled to nothing has no inverse; it stays out, and its chain
		// does without it
		if (!m.every(Number.isFinite)) continue;
		bindOf.set(n, m);
		ibm.push(...m);
		added.push(n);
	}
	if (!added.length) return 0;
	skin.joints = [...skin.joints, ...added];
	skin.inverseBindMatrices = addAccessor(glb, new Float32Array(ibm.slice(0, skin.joints.length * 16)), "MAT4");
	return added.length;
}
