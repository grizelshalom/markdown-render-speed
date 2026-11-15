// parse(markdown) returns exactly the HTML marked 18.1.3 renders with its
// default options (gfm true, breaks false, pedantic false, async false).
//
// How it is fast: the vendored marked 18.1.3 (vendor/marked/marked.esm.js,
// MIT, see vendor/marked/LICENSE and NOTICE) does the block structure and
// the rendering, but its inline tokenizer is replaced by FastTokenizer
// below. FastTokenizer keeps marked's rules for the tricky constructs
// (links, emphasis, strikethrough, autolinks, HTML) and only re-implements
// the cheap, hot rules — plain text, escapes, code spans and hard breaks —
// with small hand-written scanners instead of the big regular expressions,
// and it guards the remaining rules with a first-character test so a rule
// whose pattern cannot start at the current character never pays for a
// regular-expression execution. A fast rule only fires when its guard proves
// the token it returns is the one marked would return; anything it cannot
// prove falls back to marked's own rule, so correctness never depends on a
// fast path being complete. No state is kept between parse() calls: every
// call lexes and parses its input from scratch.

import { Lexer, Parser, Tokenizer, getDefaults } from './vendor/marked/marked.esm.js';

// ---------------------------------------------------------------------------
// Small character helpers
// ---------------------------------------------------------------------------

// ASCII letter or digit.
function isAlnumCode(code) {
  return (code >= 48 && code <= 57) // 0-9
    || (code >= 65 && code <= 90) // A-Z
    || (code >= 97 && code <= 122); // a-z
}

// ASCII word character: [A-Za-z0-9_].
function isWordCode(code) {
  return isAlnumCode(code) || code === 95; // _
}

// ASCII punctuation, the set a backslash can escape (CommonMark: every
// ASCII punctuation character). Tested by code ranges, not by a string
// search, so an escape check is a few integer comparisons.
function isAsciiPunctCode(code) {
  return (code >= 33 && code <= 47) // !"#$%&'()*+,-./
    || (code >= 58 && code <= 64) // :;<=>?@
    || (code >= 91 && code <= 96) // [\]^_`
    || (code >= 123 && code <= 126); // {|}~
}

// One ASCII letter, case-insensitive, read as a code unit.
function isLetterCode(code, lower) {
  return code === lower || code === lower - 32;
}

// A character of an email local part: [A-Za-z0-9.!#$%&'*+/=?^_`{|}~-].
function isEmailCharCode(code) {
  return isAlnumCode(code)
    || code === 46 || code === 33 || code === 35 || code === 36 // . ! # $
    || code === 37 || code === 38 || code === 39 || code === 42 // % & ' *
    || code === 43 || code === 47 || code === 61 || code === 63 // + / = ?
    || code === 94 || code === 96 || code === 123 || code === 124 // ^ ` { |
    || code === 125 || code === 126 || code === 45; // } ~ -
}

// A character of an email domain label: [A-Za-z0-9-_].
function isDomainCharCode(code) {
  return isAlnumCode(code) || code === 45 || code === 95; // - _
}

// Position of the first character after at most three leading spaces
// (the indent most block rules allow). When the source has four or more
// leading spaces this points at the fourth space, which no such rule
// accepts as its start character.
function afterIndent3(src) {
  let i = 0;
  while (i < src.length && i < 3 && src.charCodeAt(i) === 32) i++;
  return i;
}

// Is the line src[start..end) a setext underline: at most three spaces,
// then a run of `=` or a run of `-`, then only spaces or tabs?
function isSetextLine(src, start, end) {
  let i = start;
  let spaces = 0;
  while (i < end && src.charCodeAt(i) === 32 && spaces < 3) { i++; spaces++; }
  if (i >= end) return false;
  const c = src.charCodeAt(i);
  if (c !== 61 && c !== 45) return false; // = or -
  while (i < end && src.charCodeAt(i) === c) i++;
  while (i < end) {
    const d = src.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
    i++;
  }
  return true;
}

// Is the line src[start..end) blank (empty, or only spaces and tabs)?
function isBlankLine(src, start, end) {
  for (let i = start; i < end; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Where a plain-text run must stop for a bare URL or an email address
// ---------------------------------------------------------------------------

// `http://`, `https://` or `ftp://` (any case) starting at `at`? The
// reference's text rule stops just before such a start, so the url rule
// can claim the address.
function isProtocolAt(src, at) {
  const n = src.length;
  if (at + 4 > n) return false;
  const c0 = src.charCodeAt(at);
  if (isLetterCode(c0, 104) // h
    && isLetterCode(src.charCodeAt(at + 1), 116) // t
    && isLetterCode(src.charCodeAt(at + 2), 116) // t
    && isLetterCode(src.charCodeAt(at + 3), 112)) { // p
    if (at + 5 <= n && isLetterCode(src.charCodeAt(at + 4), 115) // s
      && src.charCodeAt(at + 5) === 58 && src.charCodeAt(at + 6) === 47
      && src.charCodeAt(at + 7) === 47) { // s://
      return true;
    }
    if (src.charCodeAt(at + 4) === 58 && src.charCodeAt(at + 5) === 47
      && src.charCodeAt(at + 6) === 47) { // ://
      return true;
    }
  }
  if (isLetterCode(c0, 102) // f
    && isLetterCode(src.charCodeAt(at + 1), 116) // t
    && isLetterCode(src.charCodeAt(at + 2), 112) // p
    && src.charCodeAt(at + 3) === 58 && src.charCodeAt(at + 4) === 47
    && src.charCodeAt(at + 5) === 47) { // ://
    return true;
  }
  return false;
}

// `www.` starting at `at`, with the lookbehind the reference requires:
// the `w` is at the start or follows whitespace, `*`, `_`, `~` or `(`.
// (The url rule only autolinks lowercase `www.`.)
function isWwwAt(src, at) {
  if (src.charCodeAt(at) !== 119) return false; // w
  if (src.charCodeAt(at + 1) !== 119 || src.charCodeAt(at + 2) !== 119
    || src.charCodeAt(at + 3) !== 46) { // ww.
    return false;
  }
  if (at === 0) return true;
  const prev = src[at - 1];
  return prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r'
    || prev === '\v' || prev === '\f'
    || prev === '*' || prev === '_' || prev === '~' || prev === '('
    || /\s/.test(prev);
}

// The scanner has reached an `@` at position `at`. An email autolink may
// start before it, at the start of the address's local part. Return that
// start (never before `from`, the first unscanned position), or -1 when
// this `@` belongs to no email the reference would autolink. The domain
// check mirrors the reference's extended-email rule: labels of
// [A-Za-z0-9-_], at least one dot group ending in a letter or digit, and
// no word character or `-` right after the domain.
function emailStart(src, at, from) {
  // Local part: the run of email characters ending just before the `@`.
  let s = at - 1;
  while (s >= from && isEmailCharCode(src.charCodeAt(s))) s--;
  s++;
  if (s >= at) return -1; // no local part
  // Domain: first label, then at least one `.label` ending in alnum.
  const n = src.length;
  let d = at + 1;
  const labelStart = d;
  while (d < n && isDomainCharCode(src.charCodeAt(d))) d++;
  if (d === labelStart) return -1;
  let dots = 0;
  while (d < n && src.charCodeAt(d) === 46) { // .
    dots++;
    const gstart = d + 1;
    let g = gstart;
    while (g < n && isDomainCharCode(src.charCodeAt(g))) g++;
    // A group that is empty (a sentence period, as in `a@b.c.`) or ends
    // in `-` or `_` does not extend the domain: the reference's match
    // backtracks to the groups it already has, so stop here and keep
    // them instead of failing the whole address.
    if (g === gstart) { dots--; break; } // empty group after the dot
    if (!isAlnumCode(src.charCodeAt(g - 1))) { dots--; break; } // must end alnum
    d = g;
  }
  if (dots === 0) return -1;
  if (d < n) {
    const c = src.charCodeAt(d);
    if (isWordCode(c) || c === 45) return -1; // (?![\w-])
  }
  return s;
}

// ---------------------------------------------------------------------------
// Fast inline tokenizer
// ---------------------------------------------------------------------------

// Any character that is not a space, used for the code-span strip rule
// (the reference tests /[^ ]/, a space only, not all whitespace).
const NON_SPACE = /[^ ]/;

class FastTokenizer extends Tokenizer {
  // Plain text: the reference's text rule is one large regular expression
  // with lookaheads. This scanner finds the same end position in a single
  // pass: the run ends at the first character that can start another inline
  // construct, at a hard-break boundary (two or more spaces before a
  // newline), at a bare `http(s)://` / `ftp://` / `www.` start, at an email
  // address start, or at the end of the string. Stopping early is always
  // safe — the main loop tries the construct rules there, and when none of
  // them matches the run is picked up again as text — so the scanner is
  // generous about stopping and strict about never consuming past a real
  // construct.
  inlineText(src) {
    const n = src.length;
    if (n === 0) return undefined;

    // The reference's text rule stops after a single non-alphanumeric
    // character when `mailto:` or `xmpp:` follows it, so the url rule can
    // claim the whole address (`(mailto:a@b.c)` is `(` plus one link, not
    // `mailto:` as text plus a link for `a@b.c`). Replicate that
    // one-character run here, before the first character is consumed.
    if (!isAlnumCode(src.charCodeAt(0))
      && (src.startsWith('mailto:', 1) || src.startsWith('xmpp:', 1))) {
      const raw = src.slice(0, 1);
      const escaped = this.lexer.state.inRawBlock;
      if (!escaped && raw.indexOf('&') !== -1) return super.inlineText(src);
      return { type: 'text', raw, text: raw, escaped };
    }

    // The reference always takes at least one character: a whole run of
    // backticks, a whole run of tildes, or a single other character.
    let i = 0;
    const first = src.charCodeAt(0);
    if (first === 96 || first === 126) { // ` or ~
      while (i < n && src.charCodeAt(i) === first) i++;
    } else {
      i = 1;
    }

    // Scan for the first construct start, hard-break boundary, bare URL
    // or email start.
    let end = n;
    let j = i;
    while (j < n) {
      const c = src.charCodeAt(j);
      // \ < [ ! ` * _ ~ all open a construct rule.
      if (c === 92 || c === 60 || c === 91 || c === 33
        || c === 96 || c === 42 || c === 95 || c === 126) {
        end = j;
        break;
      }
      // A newline with two or more spaces before it ends the run just
      // before those spaces, leaving them for the hard-break rule. This
      // is checked before the mailto rule below: the reference checks a
      // hard break before it checks for `mailto:`/`xmpp:`, so `a  \n`
      // plus `xmpp:` is a break, not text running up to the address.
      // A newline with fewer spaces is a soft break and stays in the
      // text, and the mailto rule may still claim it.
      if (c === 10) {
        let k = j - 1;
        while (k >= 0 && src.charCodeAt(k) === 32) k--;
        if (j - 1 - k >= 2) {
          end = k + 1;
          if (end === 0) end = 1; // never return an empty run
          break;
        }
      }
      // A non-alphanumeric character followed by `mailto:` or `xmpp:`
      // ends the run just after that character, so the url rule can
      // claim the address (the same rule as at position 0, applied
      // mid-run: `x (mailto:a@b.c)` is `x (` plus one link). The test
      // is inlined and the next character is checked first, so the
      // common case costs only two comparisons per step.
      if (j + 1 < n) {
        const nx = src.charCodeAt(j + 1);
        if ((nx === 109 || nx === 120)
          && (c < 48 || (c > 57 && c < 65) || (c > 90 && c < 97) || c > 122)
          && (src.startsWith('mailto:', j + 1) || src.startsWith('xmpp:', j + 1))) {
          end = j + 1;
          break;
        }
      }
      if (c === 64) { // @ — an email may start before it
        const s = emailStart(src, j, i);
        if (s !== -1) {
          end = s;
          break;
        }
      } else if (c === 104 || c === 72 || c === 102 || c === 70) { // h H f F
        if (isProtocolAt(src, j)) {
          end = j;
          break;
        }
      } else if (c === 119) { // w — www. (lowercase only)
        if (isWwwAt(src, j)) {
          end = j;
          break;
        }
      }
      // (A newline is handled above, before the mailto rule: a hard
      // break ends the run, a soft break stays in the text.)
      j++;
    }

    const raw = src.slice(0, end);
    const escaped = this.lexer.state.inRawBlock;
    if (!escaped && raw.indexOf('&') !== -1) {
      // A `&` may start a numeric character reference (&#...;), which the
      // reference decodes; let its rule do this one run whole.
      return super.inlineText(src);
    }
    return {
      type: 'text',
      raw,
      text: raw,
      escaped,
    };
  }

  // `\` followed by an ASCII punctuation character is an escape.
  escape(src) {
    if (src.charCodeAt(0) === 92 && src.length > 1
      && isAsciiPunctCode(src.charCodeAt(1))) {
      return {
        type: 'escape',
        raw: src.slice(0, 2),
        text: src[1],
      };
    }
    return undefined;
  }

  // A code span is an opening run of n backticks, content that neither
  // starts nor ends with a backtick, and a closing run of n backticks not
  // followed by another backtick. The closing run may be the tail of a
  // longer run, so a run of m >= n backticks closes at its last n. The
  // first closing run whose content passes the check wins, exactly as the
  // reference's lazy match does.
  codespan(src) {
    if (src.charCodeAt(0) !== 96) return undefined; // must open with `
    let n = 0;
    while (src.charCodeAt(n) === 96) n++;
    const len = src.length;
    let p = n;
    while (p < len) {
      const q = src.indexOf('`', p);
      if (q === -1) return undefined;
      let m = 0;
      while (src.charCodeAt(q + m) === 96) m++;
      if (m >= n) {
        const closeStart = q + (m - n);
        const content = src.slice(n, closeStart);
        if (content.length > 0
          && content.charCodeAt(0) !== 96
          && content.charCodeAt(content.length - 1) !== 96) {
          const raw = src.slice(0, closeStart + n);
          let text = content.indexOf('\n') === -1
            ? content
            : content.replace(/\n/g, ' ');
          if (NON_SPACE.test(text)
            && text.charCodeAt(0) === 32
            && text.charCodeAt(text.length - 1) === 32) {
            text = text.slice(1, -1);
          }
          return {
            type: 'codespan',
            raw,
            text,
          };
        }
      }
      p = q + m;
    }
    return undefined;
  }

  // A hard break is two or more spaces, or a backslash, followed by a
  // newline, and only when more non-whitespace text follows; trailing
  // spaces or tabs on the next line belong to the break.
  br(src) {
    const c0 = src.charCodeAt(0);
    let afterNewline = -1;
    if (c0 === 32) { // spaces
      let k = 0;
      while (src.charCodeAt(k) === 32) k++;
      if (k >= 2 && src.charCodeAt(k) === 10) afterNewline = k + 1;
    } else if (c0 === 92 && src.charCodeAt(1) === 10) { // backslash
      afterNewline = 2;
    }
    if (afterNewline === -1) return undefined;
    if (!/\S/.test(src.slice(afterNewline))) return undefined;
    let end = afterNewline;
    while (src.charCodeAt(end) === 32 || src.charCodeAt(end) === 9) end++;
    return {
      type: 'br',
      raw: src.slice(0, end),
    };
  }

  // The remaining rules keep the reference's behaviour, but a first
  // character that cannot start the rule skips its regular expression.
  // (emStrong and del are left untouched: overriding either makes the
  // lexer build its masked source for every inline run, which costs more
  // than the guard saves.)

  tag(src) {
    if (src.charCodeAt(0) !== 60) return undefined; // <
    return super.tag(src);
  }

  link(src) {
    const c = src.charCodeAt(0);
    if (c !== 91 && c !== 33) return undefined; // [ !
    return super.link(src);
  }

  reflink(src, links) {
    const c = src.charCodeAt(0);
    if (c !== 91 && c !== 33) return undefined; // [ !
    return super.reflink(src, links);
  }

  autolink(src) {
    if (src.charCodeAt(0) !== 60) return undefined; // <
    return super.autolink(src);
  }

  url(src) {
    // A bare URL starts with a letter or digit, or with `.`, `_`, `+`
    // or `-` as the first character of an email local part.
    const c = src.charCodeAt(0);
    if (!isAlnumCode(c) && c !== 46 && c !== 95 && c !== 43 && c !== 45) {
      return undefined;
    }
    return super.url(src);
  }

  // --- Block rules: first-character guards -------------------------------
  // Every block rule below is anchored and allows at most three leading
  // spaces, so when the first character after that indent cannot start
  // the rule, the rule cannot match and its regular expression is never
  // run. When it can start, the reference's rule decides.

  code(src) {
    // Indented code needs four spaces or a tab (after at most three
    // spaces of its own indent).
    let i = 0;
    let spaces = 0;
    while (i < src.length && src.charCodeAt(i) === 32 && spaces < 4) { i++; spaces++; }
    if (i >= src.length) return undefined;
    const c = src.charCodeAt(i);
    if (c === 9) return super.code(src); // tab
    if (spaces === 4) return super.code(src); // four spaces
    return undefined;
  }

  fences(src) {
    const i = afterIndent3(src);
    if (i >= src.length) return undefined;
    const c = src.charCodeAt(i);
    if (c !== 96 && c !== 126) return undefined; // ` ~
    let run = 0;
    while (i + run < src.length && src.charCodeAt(i + run) === c) run++;
    if (run < 3) return undefined;
    return super.fences(src);
  }

  heading(src) {
    const i = afterIndent3(src);
    if (i >= src.length || src.charCodeAt(i) !== 35) return undefined; // #
    return super.heading(src);
  }

  hr(src) {
    const i = afterIndent3(src);
    if (i >= src.length) return undefined;
    const c = src.charCodeAt(i);
    if (c !== 45 && c !== 95 && c !== 42) return undefined; // - _ *
    return super.hr(src);
  }

  blockquote(src) {
    const i = afterIndent3(src);
    if (i >= src.length || src.charCodeAt(i) !== 62) return undefined; // >
    return super.blockquote(src);
  }

  list(src) {
    const i = afterIndent3(src);
    if (i >= src.length) return undefined;
    const c = src.charCodeAt(i);
    // A marker is `-`, `*`, `+`, or a digit (ordered). Anything else
    // cannot start a list.
    if (c !== 45 && c !== 42 && c !== 43 && !(c >= 48 && c <= 57)) return undefined;
    return super.list(src);
  }

  html(src) {
    const i = afterIndent3(src);
    if (i >= src.length || src.charCodeAt(i) !== 60) return undefined; // <
    return super.html(src);
  }

  def(src) {
    const i = afterIndent3(src);
    if (i >= src.length || src.charCodeAt(i) !== 91) return undefined; // [
    return super.def(src);
  }

  table(src) {
    // A GFM table needs a delimiter line right after the header: after
    // at most three spaces it starts with `|`, `:` or `-`. Anything else
    // on that line means no table.
    const nl = src.indexOf('\n');
    if (nl === -1) return undefined;
    let i = nl + 1;
    let spaces = 0;
    while (i < src.length && src.charCodeAt(i) === 32 && spaces < 3) { i++; spaces++; }
    if (i >= src.length) return undefined;
    const c = src.charCodeAt(i);
    if (c !== 124 && c !== 58 && c !== 45) return undefined; // | : -
    return super.table(src);
  }

  lheading(src) {
    // A setext heading needs an underline line — only `=` or only `-`,
    // after at most three spaces — before the first blank line. Scan the
    // lines for one; when there is none, the rule cannot match. When one
    // is found, the reference's rule decides (it also checks that the
    // lines above it are paragraph content).
    const n = src.length;
    let pos = src.indexOf('\n');
    if (pos === -1) return undefined; // one line: no underline possible
    pos++;
    while (pos < n) {
      let end = src.indexOf('\n', pos);
      if (end === -1) end = n;
      if (isSetextLine(src, pos, end)) return super.lheading(src);
      if (isBlankLine(src, pos, end)) return undefined;
      pos = end + 1;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// One shared tokenizer; the Lexer re-points its `lexer` link on every
// construction, and the tokenizer itself holds no per-parse state, so
// sharing it across sequential parse() calls is safe.
const baseOptions = getDefaults();
const sharedOptions = {
  ...baseOptions,
  gfm: true,
  breaks: false,
  pedantic: false,
  async: false,
  tokenizer: new FastTokenizer(baseOptions),
};

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  // A shallow copy per call: the Lexer and the Parser both take the options
  // object and fill in their own renderer/tokenizer slots on it.
  const options = { ...sharedOptions };
  const lexer = new Lexer(options);
  // This is Lexer.lex, with one shortcut: the carriage-return normaliser
  // scans the whole input, so it is skipped when the input holds no `\r`
  // (a replace over such an input would return it unchanged).
  const src = markdown.indexOf('\r') === -1
    ? markdown
    : markdown.replace(/\r\n|\r/g, '\n');
  const tokens = lexer.blockTokens(src, lexer.tokens);
  const queue = lexer.inlineQueue;
  for (let i = 0; i < queue.length; i++) {
    lexer.state.inRawBlock = false;
    lexer.inlineTokens(queue[i].src, queue[i].tokens);
  }
  lexer.inlineQueue = [];
  return Parser.parse(tokens, options);
}
