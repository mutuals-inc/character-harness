// Scribe language presets: https://elevenlabs.io/docs/overview/capabilities/speech-to-text#supported-languages
// Prefer ISO 639-1 codes; retain ISO 639-3 aliases for search and saved manifests.
const rows = `af|afr|Afrikaans
am|amh|Amharic
ar|ara|Arabic
hy|hye|Armenian
as|asm|Assamese
ast|ast|Asturian
az|aze|Azerbaijani
be|bel|Belarusian
bn|ben|Bengali
bs|bos|Bosnian
bg|bul|Bulgarian
my|mya|Burmese
yue|yue|Cantonese
ca|cat|Catalan
ceb|ceb|Cebuano
ny|nya|Chichewa
hr|hrv|Croatian
cs|ces|Czech
da|dan|Danish
nl|nld|Dutch
en|eng|English
et|est|Estonian
fil|fil|Filipino
fi|fin|Finnish
fr|fra|French
ff|ful|Fulah
gl|glg|Galician
lg|lug|Ganda
ka|kat|Georgian
de|deu|German
el|ell|Greek
gu|guj|Gujarati
ha|hau|Hausa
he|heb|Hebrew
hi|hin|Hindi
hu|hun|Hungarian
is|isl|Icelandic
ig|ibo|Igbo
id|ind|Indonesian
ga|gle|Irish
it|ita|Italian
ja|jpn|Japanese
jv|jav|Javanese
kea|kea|Kabuverdianu
kn|kan|Kannada
kk|kaz|Kazakh
km|khm|Khmer
ko|kor|Korean
ku|kur|Kurdish
ky|kir|Kyrgyz
lo|lao|Lao
lv|lav|Latvian
ln|lin|Lingala
lt|lit|Lithuanian
luo|luo|Luo
lb|ltz|Luxembourgish
mk|mkd|Macedonian
ms|msa|Malay
ml|mal|Malayalam
mt|mlt|Maltese
zh|zho|Mandarin Chinese
mi|mri|Māori
mr|mar|Marathi
mn|mon|Mongolian
ne|nep|Nepali
nso|nso|Northern Sotho
no|nor|Norwegian
oc|oci|Occitan
or|ori|Odia
ps|pus|Pashto
fa|fas|Persian
pl|pol|Polish
pt|por|Portuguese
pa|pan|Punjabi
ro|ron|Romanian
ru|rus|Russian
sr|srp|Serbian
sn|sna|Shona
sd|snd|Sindhi
si|sin|Sinhala
sk|slk|Slovak
sl|slv|Slovenian
so|som|Somali
es|spa|Spanish
sw|swa|Swahili
sv|swe|Swedish
ta|tam|Tamil
tg|tgk|Tajik
te|tel|Telugu
th|tha|Thai
tr|tur|Turkish
uk|ukr|Ukrainian
umb|umb|Umbundu
ur|urd|Urdu
uz|uzb|Uzbek
vi|vie|Vietnamese
cy|cym|Welsh
wo|wol|Wolof
xh|xho|Xhosa
zu|zul|Zulu`;

const aliases: Record<string, string> = {
  en: "USA US UK Britain Australia American British",
  pt: "Brazil Brasil Portugal Brazilian português",
  es: "Spain España Mexico México Latin America español castellano",
  fr: "France français Canada Quebec Québec",
  de: "Germany Deutschland deutsch Austria Österreich",
  zh: "China Chinese Mandarin cmn 中文 普通话",
  yue: "Hong Kong Cantonese 廣東話 粤语",
  ja: "Japan 日本 日本語",
  ko: "Korea 한국어",
  ar: "Arab العربية",
  hi: "India Hindi हिन्दी",
  fil: "Philippines Filipino Tagalog tl tgl",
  fa: "Farsi Iran فارسی",
  uk: "Ukraine українська",
  ru: "Russia русский",
  my: "Myanmar Burmese",
  kea: "Cape Verde Kabuverdianu",
};

export const languages = rows.split("\n").map((row) => {
  const [code, iso3, name] = row.split("|");
  let native = name;
  try {
    native =
      new Intl.DisplayNames([code], { type: "language" }).of(code) ?? name;
  } catch {}
  return { code, iso3, name, native, tags: aliases[code] ?? "" };
});

const normalize = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
export function findLanguage(code: string) {
  return languages.find(
    (language) => language.code === code || language.iso3 === code,
  );
}
export function searchLanguages(query: string) {
  const search = normalize(query).trim();
  const terms = search.split(/\s+/);
  const rank = (language: (typeof languages)[number]) =>
    [language.code, language.iso3].includes(search)
      ? 0
      : [language.name, language.native].some(
            (name) => normalize(name) === search,
          )
        ? 1
        : [language.name, language.native].some((name) =>
              normalize(name).startsWith(search),
            )
          ? 2
          : 3;
  return languages
    .filter((language) => {
      const text = normalize(
        `${language.name} ${language.native} ${language.code} ${language.iso3} ${language.tags}`,
      );
      return terms.every((term) => text.includes(term));
    })
    .sort((a, b) => rank(a) - rank(b));
}
