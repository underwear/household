/**
 * The emoji the picker offers, by group: ones that make a good face for a bot first. Each comes with the words it
 * is found by (English, lowercase, space-separated); any other emoji can still be pasted in.
 */
export interface EmojiGroup {
  name: string;
  /** The group's mark on its tab. */
  icon: string;
  emoji: [emoji: string, words: string][];
}

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    name: "Animals",
    icon: "🦊",
    emoji: [
      ["🦉", "owl wise night bird"], ["🦊", "fox clever"], ["🐱", "cat kitty"], ["🐶", "dog puppy"], ["🐼", "panda bear"],
      ["🐻", "bear"], ["🐨", "koala"], ["🐯", "tiger"], ["🦁", "lion king"], ["🐸", "frog"], ["🐵", "monkey"],
      ["🐧", "penguin"], ["🐦", "bird"], ["🦅", "eagle bird"], ["🦜", "parrot bird talk"], ["🐢", "turtle slow"],
      ["🐙", "octopus tentacles"], ["🦑", "squid"], ["🐳", "whale"], ["🐬", "dolphin"], ["🦈", "shark"], ["🐠", "fish tropical"],
      ["🦀", "crab"], ["🐝", "bee honey busy"], ["🐞", "ladybug beetle bug"], ["🦋", "butterfly"], ["🐌", "snail slow"],
      ["🐛", "bug caterpillar"], ["🐜", "ant worker"], ["🕷️", "spider"], ["🦎", "lizard gecko"], ["🐍", "snake python"],
      ["🦖", "dinosaur t-rex"], ["🦕", "dinosaur sauropod"], ["🐲", "dragon"], ["🦄", "unicorn"], ["🐴", "horse"],
      ["🦓", "zebra"], ["🦒", "giraffe"], ["🐘", "elephant"], ["🦏", "rhino"], ["🦛", "hippo"], ["🐪", "camel"],
      ["🦙", "llama alpaca"], ["🐰", "rabbit bunny"], ["🐹", "hamster"], ["🐭", "mouse"], ["🐿️", "squirrel chipmunk"],
      ["🦔", "hedgehog"], ["🦇", "bat"], ["🦝", "raccoon"], ["🦦", "otter"], ["🦥", "sloth lazy"], ["🦘", "kangaroo"],
      ["🦡", "badger"], ["🐺", "wolf"], ["🐗", "boar"], ["🐷", "pig"], ["🐮", "cow"], ["🐑", "sheep"], ["🐐", "goat"],
      ["🦌", "deer"], ["🐔", "chicken"], ["🐣", "chick hatching"], ["🦆", "duck"], ["🦢", "swan"], ["🦩", "flamingo"],
      ["🦚", "peacock"], ["🐊", "crocodile"], ["🦭", "seal"], ["🦫", "beaver"], ["🐾", "paw prints"],
    ],
  },
  {
    name: "Characters",
    icon: "🧙",
    emoji: [
      ["🤖", "robot bot default"], ["👾", "alien monster game"], ["👽", "alien"], ["👻", "ghost"], ["💀", "skull"],
      ["🎃", "pumpkin halloween"], ["🧙", "wizard mage magic"], ["🧚", "fairy"], ["🧛", "vampire"], ["🧜", "merperson mermaid"],
      ["🧝", "elf"], ["🧞", "genie wish"], ["🧟", "zombie"], ["🦸", "superhero hero"], ["🦹", "supervillain villain"],
      ["🥷", "ninja stealth"], ["🧑‍🚀", "astronaut space"], ["🧑‍💻", "technologist developer coder"], ["🧑‍🔬", "scientist research"],
      ["🧑‍🏫", "teacher tutor"], ["🧑‍🍳", "cook chef"], ["🧑‍🎨", "artist painter"], ["🧑‍⚕️", "health doctor nurse"],
      ["🧑‍🔧", "mechanic repair"], ["🧑‍🌾", "farmer garden"], ["🧑‍✈️", "pilot"], ["🧑‍⚖️", "judge law"], ["🕵️", "detective spy"],
      ["💂", "guard"], ["👷", "construction worker builder"], ["🤴", "prince"], ["👸", "princess"], ["🎅", "santa"],
      ["🤠", "cowboy"], ["🧸", "teddy bear toy"], ["🪆", "nesting doll matryoshka"], ["🗿", "moai statue"], ["⛄", "snowman"],
    ],
  },
  {
    name: "Faces",
    icon: "😎",
    emoji: [
      ["😀", "grin happy smile"], ["😄", "smile happy"], ["😊", "blush smile"], ["🙂", "slight smile"], ["😉", "wink"],
      ["😎", "cool sunglasses"], ["🤓", "nerd glasses"], ["🧐", "monocle curious"], ["🤔", "thinking"], ["🤗", "hug"],
      ["🥳", "party celebrate"], ["😇", "angel halo"], ["😈", "devil imp"], ["🤩", "star struck"], ["😺", "cat smile"],
      ["🙃", "upside down"], ["😏", "smirk"], ["😴", "sleep"], ["🤯", "mind blown"], ["🥸", "disguise"], ["🤡", "clown"],
      ["🫡", "salute"], ["😶‍🌫️", "fog cloud face"],
    ],
  },
  {
    name: "Nature",
    icon: "🌿",
    emoji: [
      ["🌿", "herb leaf green"], ["🌱", "seedling sprout grow"], ["🌵", "cactus"], ["🌲", "evergreen tree"], ["🌳", "tree"],
      ["🌴", "palm tree"], ["🍀", "clover luck"], ["🍁", "maple leaf"], ["🍄", "mushroom"], ["🌸", "cherry blossom flower"],
      ["🌻", "sunflower"], ["🌹", "rose"], ["🌷", "tulip"], ["🪴", "potted plant"], ["🌞", "sun"], ["🌙", "moon crescent"],
      ["⭐", "star"], ["🌟", "glowing star"], ["☄️", "comet"], ["🪐", "planet saturn"], ["🌍", "earth globe world"],
      ["🌈", "rainbow"], ["⚡", "lightning zap"], ["🔥", "fire flame"], ["❄️", "snowflake cold"], ["🌊", "wave ocean"],
      ["☁️", "cloud"], ["🌪️", "tornado"], ["🌋", "volcano"], ["🏔️", "mountain snow"], ["💧", "droplet water"],
    ],
  },
  {
    name: "Food",
    icon: "🍕",
    emoji: [
      ["🍕", "pizza"], ["🍔", "burger"], ["🌮", "taco"], ["🍣", "sushi"], ["🍜", "noodles ramen"], ["🥐", "croissant"],
      ["🥨", "pretzel"], ["🧀", "cheese"], ["🥑", "avocado"], ["🍋", "lemon"], ["🍊", "orange tangerine"], ["🍎", "apple"],
      ["🍉", "watermelon"], ["🍓", "strawberry"], ["🍒", "cherries"], ["🍇", "grapes"], ["🥝", "kiwi"], ["🍍", "pineapple"],
      ["🥕", "carrot"], ["🌶️", "pepper chili hot"], ["🧄", "garlic"], ["🍩", "donut"], ["🍪", "cookie"], ["🧁", "cupcake"],
      ["🍰", "cake"], ["🍫", "chocolate"], ["🍿", "popcorn"], ["🧋", "bubble tea boba"], ["☕", "coffee"], ["🍵", "tea"],
      ["🧉", "mate"], ["🍷", "wine"], ["🍺", "beer"], ["🧃", "juice box"],
    ],
  },
  {
    name: "Things",
    icon: "🛠️",
    emoji: [
      ["🛠️", "tools hammer wrench"], ["🔧", "wrench fix"], ["🔨", "hammer"], ["⚙️", "gear settings"], ["🧰", "toolbox"],
      ["🧲", "magnet"], ["🔭", "telescope"], ["🔬", "microscope"], ["🧪", "test tube lab"], ["⚗️", "alembic chemistry"],
      ["🧬", "dna"], ["💡", "bulb idea light"], ["🔦", "flashlight"], ["🕯️", "candle"], ["🔑", "key"], ["🗝️", "old key"],
      ["🔒", "lock secure"], ["🛡️", "shield security"], ["⚔️", "swords"], ["🏹", "bow arrow"], ["🪄", "magic wand"],
      ["🔮", "crystal ball"], ["🧿", "nazar amulet"], ["📚", "books library"], ["📖", "book open read"], ["📓", "notebook"],
      ["✏️", "pencil write"], ["🖋️", "pen"], ["🖌️", "paintbrush"], ["🎨", "palette art"], ["📎", "paperclip"], ["📌", "pin"],
      ["📦", "package box"], ["🗂️", "folders"], ["🗃️", "file box archive"], ["📮", "postbox mail"], ["✉️", "envelope mail"],
      ["📬", "mailbox"], ["🧭", "compass scout"], ["🗺️", "map"], ["⏰", "alarm clock"], ["⏳", "hourglass"], ["🎁", "gift"],
      ["🎈", "balloon"], ["🎯", "target goal"], ["🎲", "dice game"], ["🧩", "puzzle"], ["♟️", "chess"], ["🎮", "game controller"],
      ["🎸", "guitar"], ["🎹", "piano keyboard"], ["🎧", "headphones"], ["🎤", "microphone"], ["📷", "camera"], ["🎬", "clapper film"],
      ["🏆", "trophy"], ["🏅", "medal"], ["👑", "crown"], ["💎", "gem diamond"], ["💰", "money bag"], ["🪙", "coin"],
      ["🧹", "broom clean"], ["🧺", "basket laundry"], ["🧼", "soap"], ["🏠", "house home"], ["🏡", "home garden"],
    ],
  },
  {
    name: "Tech & travel",
    icon: "🚀",
    emoji: [
      ["🚀", "rocket launch"], ["🛸", "ufo flying saucer"], ["🛰️", "satellite"], ["✈️", "airplane"], ["🚁", "helicopter"],
      ["⛵", "sailboat"], ["🚂", "train locomotive"], ["🚗", "car"], ["🏎️", "race car fast"], ["🚲", "bicycle bike"],
      ["🛴", "scooter"], ["⚓", "anchor"], ["💻", "laptop computer"], ["🖥️", "desktop computer"], ["⌨️", "keyboard"],
      ["🖱️", "mouse computer"], ["💾", "floppy disk save"], ["💿", "disc cd"], ["📱", "phone mobile"], ["📡", "antenna dish"],
      ["🔋", "battery"], ["🔌", "plug"], ["📟", "pager"], ["📠", "fax"], ["☎️", "telephone"], ["📺", "tv television"],
      ["📻", "radio"], ["🕹️", "joystick"], ["🧮", "abacus"], ["📊", "chart bar stats"], ["📈", "chart up growth"],
      ["📉", "chart down"], ["🗓️", "calendar"], ["📝", "memo note"], ["🔍", "search magnifier"], ["🔗", "link chain"],
      ["🌐", "globe web internet"], ["🏗️", "construction build"], ["🏭", "factory"], ["🏰", "castle"], ["🗼", "tower"],
      ["⛺", "tent camp"], ["🏝️", "island"], ["🎡", "ferris wheel"],
    ],
  },
  {
    name: "Symbols",
    icon: "💜",
    emoji: [
      ["❤️", "red heart love"], ["🧡", "orange heart"], ["💛", "yellow heart"], ["💚", "green heart"], ["💙", "blue heart"],
      ["💜", "purple heart"], ["🖤", "black heart"], ["🤍", "white heart"], ["✨", "sparkles magic"], ["💫", "dizzy star"],
      ["💥", "boom collision"], ["💬", "speech bubble chat"], ["💭", "thought bubble"], ["🗯️", "anger bubble"], ["💤", "zzz sleep"],
      ["🔔", "bell notify"], ["📣", "megaphone announce"], ["♻️", "recycle"], ["⚛️", "atom"], ["☯️", "yin yang"], ["♾️", "infinity"],
      ["✅", "check done"], ["❗", "exclamation"], ["❓", "question"], ["⚠️", "warning"], ["🚩", "flag red"], ["🏁", "checkered flag finish"],
      ["🔴", "red circle"], ["🟠", "orange circle"], ["🟡", "yellow circle"], ["🟢", "green circle"], ["🔵", "blue circle"],
      ["🟣", "purple circle"], ["⚫", "black circle"], ["🔶", "orange diamond"], ["🔷", "blue diamond"], ["🌀", "cyclone spiral"],
      ["🆕", "new"], ["🆒", "cool"], ["🆗", "ok"], ["🔝", "top"],
    ],
  },
];

/** Every emoji of the picker, once. */
export const ALL_EMOJI: [emoji: string, words: string][] = [...new Map(EMOJI_GROUPS.flatMap((group) => group.emoji)).entries()];
