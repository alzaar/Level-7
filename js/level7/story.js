// What is written on the walls: the record of someone who came through here before you.
// Each descent holds the next part of it, in order along the walkway, so reading as you go
// tells the story. The writing gets worse as they did.

// One entry per descent. Lines of at most 24 characters (A-Z 0-9 . , ! ? ' - / : and space).
// Special marks: '|' is a tally stroke, '@' a grin, '#' a handprint.
export const STORY = [
  // 1: still hopeful, still neat
  ['DAY 1. THE WATER CAME IN', 'WAITING FOR RESCUE', 'FOLLOW THE LAMPS', 'MARA AND I ARE OK', '|||| |||'],
  // 2: the rules
  ['DAY 9. NO ONE IS COMING', 'IT WONT STEP INTO LIGHT', 'NOT EVERY EXIT IS REAL', 'DONT LOOK DOWN AT IT', '|||| |||| |||| ||', '#'],
  // 3: losing Mara
  ['MARA WENT INTO THE WATER', 'SHE DIDNT COME UP', 'THE STATUES TURN', 'WHEN YOU LOOK AWAY', 'KEEP AWAY FROM WINDOWS', '#', '||||'],
  // 4: something is wrong with the writer
  ['I CANT SLEEP ANYMORE', 'IT SMILES WHEN IT RUNS', 'MY ARMS ACHE. LONGER?', 'KEEP THE TAPE RUNNING', '@', '|||| |||| |||| |||| ||||'],
  // 5: it knows them
  ['IT CALLED ME BY NAME', 'I SAW MYSELF ON THE TAPE', 'EVERY DOOR GOES DOWN', 'I KEEP SMILING', '@ @ @', '#', '#'],
  // 6: the turn
  ['MY HANDS ARE TOO LONG', 'MY FACE HURTS FROM IT', 'IT WAS ONE OF US', 'IT WAS SOMEONE BEFORE', '@ @ @ @', '||||||||||||||||||'],
  // 7: the end of the record
  ['THE LAST DOOR IS REAL', 'IF YOU READ THIS RUN', 'I AM STILL HERE', 'I AM SMILING NOW', 'I WILL BE RIGHT BEHIND', 'YOU', '@ @ @ @ @ @'],
];

// How the writing looks on each descent: colour (rgb), size of one font pixel (m; a letter
// is 7 of them tall), how shaky it is, how much paint runs, and how faded.
export function inkStyle(depth) {
  const k = Math.min(1, (depth - 1) / 6);
  const marker = [0.08, 0.075, 0.07], paint = [0.32, 0.03, 0.02];
  const t = depth <= 1 ? 0 : Math.min(1, 0.45 + 0.55 * k);
  return {
    col: marker.map((m, i) => m + (paint[i] - m) * t),
    px: 0.02 + 0.016 * k,
    shake: 0.04 + 0.4 * k,
    drip: depth <= 1 ? 0 : 0.3 + 0.7 * k,
    fade: 0.15 * (1 - k),
  };
}

// 5x7 font, '#' = ink. Index 0 is blank; 1 and 2 are the drawn grin and handprint marks.
const GLYPHS = {
  'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  'C': ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  'G': ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'I': ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  'J': ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  'M': ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  'N': ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  'Q': ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  'S': ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'V': ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  'W': ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  'X': ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  'Y': ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  'Z': ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  "'": ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '|': ['..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
};
// '@' and '#' are drawn marks, not font glyphs
const ORDER = [' ', '@', '#', ...Object.keys(GLYPHS)];

export const CHAR_CODE = new Map(ORDER.map((c, i) => [c, i]));

// The font as u32 words, two per glyph (rows 0-3 in the first, 4-6 in the second, 5 bits
// per row, row 0 in the low bits, column 0 in the low bit of each row). It goes at the
// start of the text buffer the shader reads, followed by the text itself.
export const FONT_WORDS = ORDER.length * 2;
export function fontWords() {
  const out = new Uint32Array(FONT_WORDS);
  ORDER.forEach((c, i) => {
    const g = GLYPHS[c];
    if (!g) return;
    for (let r = 0; r < 7; r++) {
      let bits = 0;
      for (let x = 0; x < 5; x++) if (g[r][x] === '#') bits |= 1 << x;
      out[i * 2 + (r < 4 ? 0 : 1)] |= bits << ((r < 4 ? r : r - 4) * 5);
    }
  });
  return out;
}

// Text -> glyph codes. Unknown characters become blanks.
export function encodeLine(text) {
  return [...text.toUpperCase()].map((c) => CHAR_CODE.get(c) ?? 0);
}
