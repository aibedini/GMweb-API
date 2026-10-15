/**
 * Curated native-Unicode emoji set.
 *
 * Every entry is a plain Unicode sequence — no image, no sprite, no CDN. Kept
 * intentionally small (a few hundred common sequences) so the lazy chunk stays
 * tiny while still covering the reactions and symbols people actually send.
 */

export type EmojiCategory = "smileys" | "people" | "animals" | "food" | "activity" | "travel" | "objects" | "symbols" | "flags";

export interface EmojiEntry {
  emoji: string;
  name: string;
  category: EmojiCategory;
}

export const EMOJI_GROUPS: Array<{ id: EmojiCategory | "ALL"; label: string; glyph: string }> = [
  { id: "ALL", label: "All emoji", glyph: "🕘" },
  { id: "smileys", label: "Smileys and emotions", glyph: "😀" },
  { id: "people", label: "People and hands", glyph: "👋" },
  { id: "animals", label: "Animals and nature", glyph: "🐶" },
  { id: "food", label: "Food and drink", glyph: "🍔" },
  { id: "activity", label: "Activity", glyph: "⚽" },
  { id: "travel", label: "Travel and places", glyph: "✈️" },
  { id: "objects", label: "Objects", glyph: "💡" },
  { id: "symbols", label: "Symbols", glyph: "❤️" },
  { id: "flags", label: "Flags", glyph: "🏳️" },
];

function group(category: EmojiCategory, rows: Array<[string, string]>): EmojiEntry[] {
  return rows.map(([emoji, name]) => ({ emoji, name, category }));
}

// Complex sequences are included verbatim (ZWJ families, VS16, skin tones,
// regional indicators, keycaps) so nothing is normalised away before sending.
const ENTRIES: EmojiEntry[] = [
  ...group("smileys", [
    ["😀", "grinning face"], ["😃", "grinning face with big eyes"], ["😄", "grinning face with smiling eyes"],
    ["😁", "beaming face"], ["😆", "grinning squinting face"], ["😅", "grinning face with sweat"],
    ["🤣", "rolling on the floor laughing"], ["😂", "face with tears of joy"], ["🙂", "slightly smiling face"],
    ["🙃", "upside-down face"], ["😉", "winking face"], ["😊", "smiling face with smiling eyes"],
    ["😇", "smiling face with halo"], ["🥰", "smiling face with hearts"], ["😍", "heart eyes"],
    ["🤩", "star-struck"], ["😘", "face blowing a kiss"], ["😗", "kissing face"], ["☺️", "smiling face"],
    ["😚", "kissing face with closed eyes"], ["😋", "face savouring food"], ["😛", "face with tongue"],
    ["😜", "winking face with tongue"], ["🤪", "zany face"], ["🤨", "raised eyebrow"],
    ["🧐", "face with monocle"], ["🤓", "nerd face"], ["😎", "smiling face with sunglasses"],
    ["🥳", "partying face"], ["😏", "smirking face"], ["😒", "unamused face"], ["😞", "disappointed face"],
    ["😔", "pensive face"], ["😟", "worried face"], ["😕", "confused face"], ["🙁", "slightly frowning face"],
    ["😣", "persevering face"], ["😖", "confounded face"], ["😫", "tired face"], ["😩", "weary face"],
    ["🥺", "pleading face"], ["🥹", "face holding back tears"], ["😢", "crying face"],
    ["😭", "loudly crying face"], ["😤", "face with steam from nose"], ["😠", "angry face"],
    ["😡", "pouting face"], ["🤬", "face with symbols on mouth"], ["🤯", "exploding head"],
    ["😳", "flushed face"], ["🥵", "hot face"], ["🥶", "cold face"], ["😱", "face screaming in fear"],
    ["😨", "fearful face"], ["😰", "anxious face with sweat"], ["😥", "sad but relieved face"],
    ["😓", "downcast face with sweat"], ["🤗", "hugging face"], ["🤔", "thinking face"],
    ["🤭", "face with hand over mouth"], ["🤫", "shushing face"], ["🤥", "lying face"],
    ["😶", "face without mouth"], ["😐", "neutral face"], ["😑", "expressionless face"],
    ["😬", "grimacing face"], ["🙄", "face with rolling eyes"], ["😯", "hushed face"],
    ["😴", "sleeping face"], ["🤤", "drooling face"], ["😪", "sleepy face"], ["😵", "dizzy face"],
    ["🤐", "zipper-mouth face"], ["🥴", "woozy face"], ["🤢", "nauseated face"], ["🤮", "vomiting face"],
    ["🤧", "sneezing face"], ["😷", "face with medical mask"], ["🤒", "face with thermometer"],
    ["🤕", "face with head-bandage"], ["🤑", "money-mouth face"], ["🤠", "cowboy hat face"],
    ["😈", "smiling face with horns"], ["👿", "angry face with horns"], ["👻", "ghost"],
    ["💀", "skull"], ["☠️", "skull and crossbones"], ["👽", "alien"], ["🤖", "robot"],
    ["💩", "pile of poo"], ["🤡", "clown face"],
  ]),
  ...group("people", [
    ["👋", "waving hand"], ["🤚", "raised back of hand"], ["✋", "raised hand"], ["🖖", "vulcan salute"],
    ["👌", "OK hand"], ["🤌", "pinched fingers"], ["🤏", "pinching hand"], ["✌️", "victory hand"],
    ["🤞", "crossed fingers"], ["🤟", "love-you gesture"], ["🤘", "sign of the horns"],
    ["🤙", "call me hand"], ["👈", "backhand index pointing left"], ["👉", "backhand index pointing right"],
    ["👆", "backhand index pointing up"], ["👇", "backhand index pointing down"], ["☝️", "index pointing up"],
    ["👍", "thumbs up"], ["👍🏽", "thumbs up medium skin tone"], ["👎", "thumbs down"],
    ["✊", "raised fist"], ["👊", "oncoming fist"], ["🤛", "left-facing fist"], ["🤜", "right-facing fist"],
    ["👏", "clapping hands"], ["🙌", "raising hands"], ["👐", "open hands"], ["🤲", "palms up together"],
    ["🤝", "handshake"], ["🙏", "folded hands"], ["✍️", "writing hand"], ["💅", "nail polish"],
    ["💪", "flexed biceps"], ["🦵", "leg"], ["🦶", "foot"], ["👂", "ear"], ["👃", "nose"],
    ["🧠", "brain"], ["👀", "eyes"], ["👁️", "eye"], ["👅", "tongue"], ["👄", "mouth"],
    ["👶", "baby"], ["🧒", "child"], ["👦", "boy"], ["👧", "girl"], ["🧑", "person"],
    ["👨", "man"], ["👩", "woman"], ["🧓", "older person"], ["👴", "old man"], ["👵", "old woman"],
    ["👨‍👩‍👧‍👦", "family"], ["👩‍💻", "woman technologist"], ["🧑‍💻", "technologist"],
    ["🙋", "person raising hand"], ["🙅", "person gesturing no"], ["🙆", "person gesturing OK"],
    ["💁", "person tipping hand"], ["🙇", "person bowing"], ["🤦", "person facepalming"],
    ["🤷", "person shrugging"], ["🧑‍⚕️", "health worker"], ["🧑‍🏫", "teacher"], ["🧑‍🍳", "cook"],
  ]),
  ...group("animals", [
    ["🐶", "dog face"], ["🐱", "cat face"], ["🐭", "mouse face"], ["🐹", "hamster"], ["🐰", "rabbit face"],
    ["🦊", "fox"], ["🐻", "bear"], ["🐼", "panda"], ["🐨", "koala"], ["🐯", "tiger face"],
    ["🦁", "lion"], ["🐮", "cow face"], ["🐷", "pig face"], ["🐸", "frog"], ["🐵", "monkey face"],
    ["🐔", "chicken"], ["🐧", "penguin"], ["🐦", "bird"], ["🦆", "duck"], ["🦅", "eagle"],
    ["🦉", "owl"], ["🦇", "bat"], ["🐺", "wolf"], ["🐗", "boar"], ["🐴", "horse face"],
    ["🦄", "unicorn"], ["🐝", "honeybee"], ["🦋", "butterfly"], ["🐌", "snail"], ["🐞", "lady beetle"],
    ["🐢", "turtle"], ["🐍", "snake"], ["🐙", "octopus"], ["🦑", "squid"], ["🦐", "shrimp"],
    ["🐠", "tropical fish"], ["🐟", "fish"], ["🐬", "dolphin"], ["🐳", "spouting whale"], ["🦈", "shark"],
    ["🌵", "cactus"], ["🎄", "Christmas tree"], ["🌲", "evergreen tree"], ["🌳", "deciduous tree"],
    ["🌴", "palm tree"], ["🌱", "seedling"], ["🌿", "herb"], ["☘️", "shamrock"], ["🍀", "four leaf clover"],
    ["🍁", "maple leaf"], ["🍂", "fallen leaf"], ["🌷", "tulip"], ["🌹", "rose"], ["🌻", "sunflower"],
    ["🌞", "sun with face"], ["🌝", "full moon face"], ["⭐", "star"], ["🌟", "glowing star"],
    ["✨", "sparkles"], ["⚡", "high voltage"], ["🔥", "fire"], ["🌈", "rainbow"], ["☀️", "sun"],
    ["⛅", "sun behind cloud"], ["☁️", "cloud"], ["🌧️", "rain"], ["⛈️", "thunder cloud and rain"],
    ["❄️", "snowflake"], ["🌊", "water wave"],
  ]),
  ...group("food", [
    ["🍏", "green apple"], ["🍎", "red apple"], ["🍐", "pear"], ["🍊", "tangerine"], ["🍋", "lemon"],
    ["🍌", "banana"], ["🍉", "watermelon"], ["🍇", "grapes"], ["🍓", "strawberry"], ["🫐", "blueberries"],
    ["🍒", "cherries"], ["🍑", "peach"], ["🥭", "mango"], ["🍍", "pineapple"], ["🥥", "coconut"],
    ["🥝", "kiwi"], ["🍅", "tomato"], ["🥑", "avocado"], ["🥦", "broccoli"], ["🥒", "cucumber"],
    ["🌽", "ear of corn"], ["🥕", "carrot"], ["🧄", "garlic"], ["🧅", "onion"], ["🥔", "potato"],
    ["🍞", "bread"], ["🥐", "croissant"], ["🥖", "baguette"], ["🧀", "cheese wedge"], ["🥚", "egg"],
    ["🍳", "cooking"], ["🧇", "waffle"], ["🥞", "pancakes"], ["🍔", "hamburger"], ["🍟", "french fries"],
    ["🍕", "pizza"], ["🌭", "hot dog"], ["🥪", "sandwich"], ["🌮", "taco"], ["🌯", "burrito"],
    ["🍜", "steaming bowl"], ["🍝", "spaghetti"], ["🍣", "sushi"], ["🍤", "fried shrimp"],
    ["🍚", "cooked rice"], ["🍛", "curry rice"], ["🥘", "shallow pan of food"], ["🍲", "pot of food"],
    ["🧂", "salt"], ["🍦", "soft ice cream"], ["🍰", "shortcake"], ["🎂", "birthday cake"],
    ["🍫", "chocolate bar"], ["🍬", "candy"], ["🍭", "lollipop"], ["🍯", "honey pot"],
    ["☕", "hot beverage"], ["🍵", "teacup without handle"], ["🧋", "bubble tea"], ["🥤", "cup with straw"],
    ["🍺", "beer mug"], ["🍷", "wine glass"], ["🥂", "clinking glasses"], ["💧", "droplet"],
  ]),
  ...group("activity", [
    ["⚽", "soccer ball"], ["🏀", "basketball"], ["🏈", "american football"], ["⚾", "baseball"],
    ["🎾", "tennis"], ["🏐", "volleyball"], ["🏓", "ping pong"], ["🏸", "badminton"],
    ["🥊", "boxing glove"], ["🎯", "bullseye"], ["🎳", "bowling"], ["🎮", "video game"],
    ["🎲", "game die"], ["🧩", "puzzle piece"], ["🎨", "artist palette"], ["🎬", "clapper board"],
    ["🎤", "microphone"], ["🎧", "headphone"], ["🎵", "musical note"], ["🎶", "musical notes"],
    ["🎸", "guitar"], ["🎹", "musical keyboard"], ["🥁", "drum"], ["🏆", "trophy"],
    ["🥇", "1st place medal"], ["🏅", "sports medal"], ["🎁", "wrapped gift"], ["🎉", "party popper"],
    ["🎊", "confetti ball"], ["🎈", "balloon"], ["🪄", "magic wand"], ["👑", "crown"],
  ]),
  ...group("travel", [
    ["🚗", "automobile"], ["🚕", "taxi"], ["🚙", "sport utility vehicle"], ["🚌", "bus"],
    ["🚎", "trolleybus"], ["🏎️", "racing car"], ["🚓", "police car"], ["🚑", "ambulance"],
    ["🚒", "fire engine"], ["🚚", "delivery truck"], ["🚜", "tractor"], ["🛵", "motor scooter"],
    ["🏍️", "motorcycle"], ["🚲", "bicycle"], ["🛴", "kick scooter"], ["🚂", "locomotive"],
    ["✈️", "airplane"], ["🛫", "airplane departure"], ["🚀", "rocket"], ["🛰️", "satellite"],
    ["🚁", "helicopter"], ["⛵", "sailboat"], ["🚢", "ship"], ["⚓", "anchor"],
    ["🏠", "house"], ["🏢", "office building"], ["🏥", "hospital"], ["🏦", "bank"],
    ["🏨", "hotel"], ["🏫", "school"], ["🕌", "mosque"], ["⛪", "church"],
    ["🗼", "Tokyo tower"], ["🗽", "Statue of Liberty"], ["🌍", "globe showing Europe and Africa"],
    ["🌎", "globe showing Americas"], ["🌏", "globe showing Asia and Australia"], ["🗺️", "world map"],
    ["🧭", "compass"], ["🏔️", "snow-capped mountain"], ["🏖️", "beach with umbrella"], ["🏝️", "desert island"],
  ]),
  ...group("objects", [
    ["📱", "mobile phone"], ["💻", "laptop"], ["⌨️", "keyboard"], ["🖥️", "desktop computer"],
    ["🖨️", "printer"], ["🖱️", "computer mouse"], ["💾", "floppy disk"], ["💿", "optical disk"],
    ["📷", "camera"], ["📹", "video camera"], ["📺", "television"], ["📻", "radio"],
    ["⏰", "alarm clock"], ["⌚", "watch"], ["⏳", "hourglass not done"], ["🔋", "battery"],
    ["🔌", "electric plug"], ["💡", "light bulb"], ["🔦", "flashlight"], ["🕯️", "candle"],
    ["📚", "books"], ["📖", "open book"], ["📝", "memo"], ["✏️", "pencil"], ["🖊️", "pen"],
    ["📌", "pushpin"], ["📎", "paperclip"], ["📁", "file folder"], ["📅", "calendar"],
    ["📊", "bar chart"], ["📈", "chart increasing"], ["📉", "chart decreasing"], ["🗂️", "card index dividers"],
    ["🔒", "locked"], ["🔓", "unlocked"], ["🔑", "key"], ["🗝️", "old key"], ["🛡️", "shield"],
    ["🔔", "bell"], ["📢", "loudspeaker"], ["📣", "megaphone"], ["🔍", "magnifying glass tilted left"],
    ["💰", "money bag"], ["💳", "credit card"], ["🧾", "receipt"], ["📦", "package"],
    ["✉️", "envelope"], ["📩", "envelope with arrow"], ["📨", "incoming envelope"], ["📮", "postbox"],
    ["🩹", "adhesive bandage"], ["💊", "pill"], ["🩺", "stethoscope"], ["🧼", "soap"],
  ]),
  ...group("symbols", [
    ["❤️", "red heart"], ["🧡", "orange heart"], ["💛", "yellow heart"], ["💚", "green heart"],
    ["💙", "blue heart"], ["💜", "purple heart"], ["🖤", "black heart"], ["🤍", "white heart"],
    ["🤎", "brown heart"], ["💔", "broken heart"], ["❣️", "heart exclamation"], ["💕", "two hearts"],
    ["💞", "revolving hearts"], ["💓", "beating heart"], ["💗", "growing heart"], ["💖", "sparkling heart"],
    ["💘", "heart with arrow"], ["💝", "heart with ribbon"], ["✅", "check mark button"],
    ["☑️", "check box with check"], ["✔️", "check mark"], ["❌", "cross mark"], ["❎", "cross mark button"],
    ["⭕", "hollow red circle"], ["❗", "exclamation mark"], ["❓", "question mark"],
    ["⚠️", "warning"], ["🚫", "prohibited"], ["♻️", "recycling symbol"], ["🔰", "Japanese symbol for beginner"],
    ["🆗", "OK button"], ["🆕", "new button"], ["🔝", "top arrow"], ["🔄", "counterclockwise arrows"],
    ["🔁", "repeat button"], ["▶️", "play button"], ["⏸️", "pause button"], ["⏹️", "stop button"],
    ["🔊", "speaker high volume"], ["🔇", "muted speaker"], ["1️⃣", "keycap 1"], ["2️⃣", "keycap 2"],
    ["3️⃣", "keycap 3"], ["🔟", "keycap 10"], ["💯", "hundred points"], ["🆒", "cool button"],
    ["➕", "plus"], ["➖", "minus"], ["✖️", "multiply"], ["➗", "divide"], ["♾️", "infinity"],
    ["💤", "zzz"], ["💬", "speech balloon"], ["🗯️", "right anger bubble"], ["💭", "thought balloon"],
  ]),
  ...group("flags", [
    ["🏳️", "white flag"], ["🏴", "black flag"], ["🏁", "chequered flag"], ["🚩", "triangular flag"],
    ["🏳️‍🌈", "rainbow flag"], ["🏴‍☠️", "pirate flag"], ["🇮🇷", "Iran"], ["🇺🇸", "United States"],
    ["🇬🇧", "United Kingdom"], ["🇩🇪", "Germany"], ["🇫🇷", "France"], ["🇹🇷", "Türkiye"],
    ["🇦🇪", "United Arab Emirates"], ["🇸🇦", "Saudi Arabia"], ["🇮🇶", "Iraq"], ["🇦🇫", "Afghanistan"],
    ["🇵🇰", "Pakistan"], ["🇮🇳", "India"], ["🇨🇳", "China"], ["🇯🇵", "Japan"], ["🇰🇷", "South Korea"],
    ["🇷🇺", "Russia"], ["🇨🇦", "Canada"], ["🇦🇺", "Australia"], ["🇧🇷", "Brazil"], ["🇪🇸", "Spain"],
    ["🇮🇹", "Italy"], ["🇳🇱", "Netherlands"], ["🇸🇪", "Sweden"], ["🇨🇭", "Switzerland"], ["🇺🇦", "Ukraine"],
    ["🇪🇺", "European Union"], ["🇺🇳", "United Nations"],
  ]),
];

export const EMOJI: EmojiEntry[] = ENTRIES;

/** Substring search over the stable English names, plus a direct glyph match. */
export function searchEmoji(query: string): EmojiEntry[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return EMOJI;
  if (EMOJI.some(entry => entry.emoji === trimmed)) return [EMOJI.find(entry => entry.emoji === trimmed)!];
  return EMOJI.filter(entry => entry.name.includes(trimmed));
}
