// Username rules shared by the server and the pages. checkName(name) returns
// { ok: true } or { ok: false, reason }. The server also asks the local AI
// (see server.js) about names that pass these rules, which catches made-up
// combinations these lists can't.
//
// Two kinds of blocked words:
//  - STRONG: blocked anywhere in the name, even disguised (f.u.c.k, fuuuck,
//    4dm1n). Only words that basically never appear inside innocent ones.
//  - WORDS: blocked only as a separate word ("Ass Kicker" is blocked,
//    "Classic" and "Bassist" are fine).

(function (root) {
  const LOOKALIKE = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "8": "b", "9": "g" };

  const STRONG = [
    "fuck", "fuk", "fuq", "fck", "fvck", "phuck", "fcuk", "cumshot", "cumstain", "cumslut", "shit", "cunt", "bitch", "whore", "slut", "porn", "hentai", "dildo", "blowjob", "handjob",
    "jizz", "pussy", "penis", "vagina", "boob", "orgasm", "masturb", "onlyfans", "milf", "horny", "naked", "nude",
    "nigger", "nigga", "niga", "nigg", "faggot", "fagot", "tranny", "retard", "kike", "chink", "wetback", "beaner", "raghead", "towelhead",
    "hitler", "nazi", "siegheil", "whitepower", "whitepride", "swastika", "gaschamber", "holocaust", "genocide", "rapist", "pedophile", "pedo",
    "molest", "incest", "asshole", "arsehole", "motherf", "killyourself", "kilyourself", "suicide", "selfharm", "cocaine", "heroin", "fentanyl",
    "kkk", "1488", "88heil",
  ];
  const WORDS = [
    "ass", "asses", "butt", "booty", "tit", "tits", "titty", "cum", "anal", "anus", "hoe", "hoes", "rape", "raped", "sex", "sexy", "nsfw", "xxx",
    "nut", "nuts", "balls", "cock", "dick", "dicks", "prick", "twat", "wank", "piss", "homo", "lesbo", "dyke", "fag", "fags", "gay", "jew", "jews",
    "coon", "spic", "paki", "gook", "isis", "jihad", "kys", "die", "meth", "weed", "crack", "coke", "drug", "drugs", "dealer", "stoner", "lsd",
    "kill", "racist", "racism", "stfu",
  ];
  const STAFF_STRONG = ["admin", "administrator", "moderator", "keyace", "official", "staff", "elosupport", "eloteam", "elostaff"];
  const STAFF_WORDS = ["mod", "mods", "dev", "devs", "owner", "support", "system", "server", "gm"];
  // Real words that happen to contain a blocked one; removed before checking
  const SAFE_CONTAINING = ["badminton", "staffordshire", "therapist", "scunthorpe", "shiitake", "penistone"];

  const leet = (s) => String(s).toLowerCase().replace(/[0-9!|@$]/g, (c) => LOOKALIKE[c] || c);
  // Letters only, with look-alikes mapped (keeps doubled letters)
  const flat = (s) => leet(s).replace(/[^a-z]/g, "");
  const collapse = (s) => s.replace(/(.)\1+/g, "$1");
  // Words split on spaces, _, - and camelCase — read two ways, so digits can
  // be letters in disguise ("B00ty" -> booty) or separators ("Tits4U" -> tits)
  function words(name) {
    const spaced = String(name || "").replace(/([a-z])([A-Z])/g, "$1 $2");
    const asLetters = spaced.split(/[^A-Za-z0-9!|@$]+/);
    const digitsSplit = spaced.split(/[^A-Za-z0-9!|@$]+|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/);
    return [...new Set([...asLetters, ...digitsSplit].map((w) => flat(w)).filter(Boolean))];
  }
  // Does `text` contain `bad`, even with stretched letters (fuuuck)?
  function containsStrong(text, bad) {
    const b = flat(bad);
    if (text.includes(b)) return true;
    return b === collapse(b) && collapse(text).includes(b);
  }

  function checkName(name, { allowStaffNames = false } = {}) {
    const raw = String(name || "").trim();
    if (!/^[A-Za-z0-9 _-]{2,20}$/.test(raw)) return { ok: false, reason: "Names are 2–20 letters, numbers, spaces, _ or -" };
    if ((raw.match(/[A-Za-z]/g) || []).length < 2) return { ok: false, reason: "Names need at least 2 letters" };
    if (/(.)\1{3,}/i.test(raw)) return { ok: false, reason: "Too many of the same character in a row" };
    if (/[ _-]{2,}/.test(raw) || /^[ _-]|[ _-]$/.test(raw)) return { ok: false, reason: "Spaces, _ and - can't be doubled or at the ends" };
    if ((raw.match(/[0-9]/g) || []).length > 6) return { ok: false, reason: "Too many numbers" };

    const text = SAFE_CONTAINING.reduce((t, s) => t.split(s).join(" "), flat(raw)).replace(/ /g, "");
    const rawDigits = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const bad of STRONG) {
      if (/^[0-9]+$/.test(bad) ? rawDigits.includes(bad) : containsStrong(text, bad)) return { ok: false, reason: "That name isn't allowed" };
    }
    const ws = words(raw);
    for (const w of ws) if (WORDS.includes(w) || WORDS.includes(collapse(w))) return { ok: false, reason: "That name isn't allowed" };

    if (!allowStaffNames) {
      for (const s of STAFF_STRONG) if (containsStrong(text, s)) return { ok: false, reason: "Names can't look like staff or the admin" };
      for (const w of ws) if (STAFF_WORDS.includes(w)) return { ok: false, reason: "Names can't look like staff or the admin" };
    }
    return { ok: true };
  }

  // Chat filter: blocked words become stars ("you ****"). Checks each word
  // (and pairs of words, for "f u c k"-style spacing) with the same rules as names.
  // Fine in chess chat even though they're not allowed in names ("I'll kill your queen")
  const CHAT_OK = new Set(["kill", "die", "crack", "coke", "drug", "drugs", "dealer", "pot", "nut", "nuts", "balls", "stoner", "lsd", "jihad", "isis", "racist", "racism", "stfu", "gay"]);
  function cleanText(text) {
    const s = String(text || "");
    const tokens = s.split(/(\s+)/); // keep the spaces
    const bad = (w) => {
      const t = flat(w);
      if (!t || CHAT_OK.has(t)) return false;
      if (WORDS.includes(t) || WORDS.includes(collapse(t))) return true;
      return STRONG.some((b) => (/^[0-9]+$/.test(b) ? w.includes(b) : containsStrong(t, b)));
    };
    const SAFE = new Set(SAFE_CONTAINING);
    const out = tokens.map((tok) => (/\s/.test(tok) || SAFE.has(flat(tok)) ? tok : bad(tok) ? tok.replace(/[^\s]/g, "*") : tok));
    // Letters spread out with spaces: "f u c k you" → "* * * * you"
    for (let i = 0; i < out.length; i += 2) {
      let j = i;
      while (j < out.length && out[j].length === 1 && /[A-Za-z0-9@$!|]/.test(out[j])) j += 2;
      const run = out.slice(i, j).filter((_, k) => k % 2 === 0);
      if (run.length >= 3 && bad(run.join(""))) for (let k = i; k < j; k += 2) out[k] = "*";
      if (j > i) i = j - 2;
    }
    return out.join("");
  }

  const api = { checkName, cleanText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EloNames = api;
})(typeof window !== "undefined" ? window : globalThis);
