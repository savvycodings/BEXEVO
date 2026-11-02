/**
 * Drill catalogue: the default rows for the `technique_drill` table, and the ranking that picks
 * drills for a shot. Content lives in the table so it can be edited without a deploy; these
 * defaults are only inserted when the table is empty.
 */

/** What a drill works on. The first four match the app's "biggest mistakes". */
export type DrillFocus = "elbow" | "racket" | "torso" | "foot";
export type DrillLevel = "beginner" | "intermediate" | "advanced";
export type DrillLang = "en" | "es";

export type DrillCopy = {
  title: string;
  summary: string;
  /** Short tag under the summary, e.g. "Lower body". */
  focusLabel: string;
  steps: string[];
};

export type DrillRow = {
  slug: string;
  level: DrillLevel;
  minutes: number;
  focus: DrillFocus[];
  /** Shot tags this drill is for (see `shotTags`); empty means any shot. */
  shots: string[];
  videoUrl: string | null;
  sort: number;
  content: Record<DrillLang, DrillCopy>;
};

export type DrillOut = Omit<DrillRow, "content" | "sort" | "shots"> & DrillCopy;

export const DRILL_FOCUS: DrillFocus[] = ["elbow", "racket", "torso", "foot"];

const SHOT_WORDS: Record<string, string[]> = {
  volley: ["volley", "volea"],
  bandeja: ["bandeja"],
  vibora: ["vibora", "víbora"],
  smash: ["smash", "remate"],
  lob: ["lob", "globo"],
  serve: ["serve", "saque"],
  drive: ["drive"],
  forehand: ["forehand", "derecha", "drive"],
  backhand: ["backhand", "revés", "reves"],
};

/** Shot tags found in a free-text shot label ("Forehand volley" → forehand, volley). */
export function shotTags(label: string | null | undefined): string[] {
  const text = (label ?? "").toLowerCase();
  if (!text) return [];
  return Object.entries(SHOT_WORDS)
    .filter(([, words]) => words.some((w) => text.includes(w)))
    .map(([tag]) => tag);
}

/** Valid focus ids from a comma list, in the order given (most important first). */
export function parseFocus(raw: unknown): DrillFocus[] {
  const parts = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw.map(String) : [];
  const out: DrillFocus[] = [];
  for (const p of parts) {
    const id = p.trim().toLowerCase() as DrillFocus;
    if (DRILL_FOCUS.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Best drills first. Each focus the drill covers scores by its priority (first focus counts most),
 * a matching shot adds 2, and a drill written for other shots loses 3. Ties keep catalogue order.
 */
export function rankDrills(rows: DrillRow[], focus: DrillFocus[], shotLabel: string | null, limit = 3): DrillRow[] {
  const tags = shotTags(shotLabel);
  const scored = rows.map((row) => {
    let score = 0;
    focus.forEach((f, i) => {
      if (row.focus.includes(f)) score += focus.length - i;
    });
    if (row.shots.length) score += row.shots.some((s) => tags.includes(s)) ? 2 : tags.length ? -3 : 0;
    return { row, score };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.row.sort - b.row.sort)
    .slice(0, Math.max(1, limit))
    .map((s) => s.row);
}

export function localizeDrill(row: DrillRow, lang: DrillLang): DrillOut {
  const copy = row.content[lang] ?? row.content.en;
  return {
    slug: row.slug,
    level: row.level,
    minutes: row.minutes,
    focus: row.focus,
    videoUrl: row.videoUrl,
    ...copy,
  };
}

export const DEFAULT_DRILLS: DrillRow[] = [
  {
    slug: "split-step-volley",
    level: "beginner",
    minutes: 8,
    focus: ["foot", "racket"],
    shots: ["volley"],
    videoUrl: null,
    sort: 10,
    content: {
      en: {
        title: "Split Step + Volley",
        summary: "Improve lower-body stability, timing and racket preparation.",
        focusLabel: "Lower body",
        steps: [
          "Start at the net in a ready stance, racket up in front of your chest.",
          "Split step as your partner hits: a small hop, landing on the balls of both feet.",
          "Step toward the ball with the opposite foot and block the volley, no backswing.",
          "Recover to the ready stance before the next feed. 3 sets of 10.",
        ],
      },
      es: {
        title: "Split step + volea",
        summary: "Mejora la estabilidad de piernas, el timing y la preparación de la pala.",
        focusLabel: "Tren inferior",
        steps: [
          "Empieza en la red en posición de espera, con la pala delante del pecho.",
          "Haz el split step cuando golpee tu compañero: un pequeño salto cayendo sobre la punta de ambos pies.",
          "Da un paso hacia la bola con el pie contrario y bloquea la volea, sin armar atrás.",
          "Vuelve a la posición de espera antes de la siguiente bola. 3 series de 10.",
        ],
      },
    },
  },
  {
    slug: "shadow-volley",
    level: "beginner",
    minutes: 6,
    focus: ["elbow", "racket"],
    shots: ["volley"],
    videoUrl: null,
    sort: 20,
    content: {
      en: {
        title: "Shadow Volley",
        summary: "Perfect racket preparation and elbow position.",
        focusLabel: "Racket control",
        steps: [
          "Without a ball, stand side-on to a mirror or wall.",
          "Bring the racket up early, head above the wrist, elbow a hand-width in front of the body.",
          "Push the racket forward a short way and freeze. Check the elbow hasn't tucked in.",
          "20 slow reps forehand, 20 backhand.",
        ],
      },
      es: {
        title: "Volea en sombra",
        summary: "Perfecciona la preparación de la pala y la posición del codo.",
        focusLabel: "Control de pala",
        steps: [
          "Sin bola, colócate de perfil frente a un espejo o una pared.",
          "Sube la pala pronto, la cabeza por encima de la muñeca y el codo un palmo por delante del cuerpo.",
          "Empuja la pala un poco hacia delante y congela. Comprueba que el codo no se ha pegado al cuerpo.",
          "20 repeticiones lentas de derecha y 20 de revés.",
        ],
      },
    },
  },
  {
    slug: "controlled-feed",
    level: "intermediate",
    minutes: 8,
    focus: ["elbow", "racket"],
    shots: [],
    videoUrl: null,
    sort: 30,
    content: {
      en: {
        title: "Controlled Feed Drill",
        summary: "Build consistent contact position with live balls.",
        focusLabel: "Contact point",
        steps: [
          "A partner feeds easy balls to the same spot from the service line.",
          "Meet each ball in front of your front hip, elbow away from the body.",
          "Aim every shot at a target zone; count how many land in it.",
          "4 rounds of 12 balls, resting 1 minute between rounds.",
        ],
      },
      es: {
        title: "Bolas controladas",
        summary: "Consigue un punto de impacto constante con bola en juego.",
        focusLabel: "Punto de impacto",
        steps: [
          "Un compañero te lanza bolas fáciles al mismo sitio desde la línea de saque.",
          "Golpea cada bola por delante de la cadera adelantada, con el codo separado del cuerpo.",
          "Apunta cada golpe a una zona objetivo y cuenta cuántas entran.",
          "4 rondas de 12 bolas, con 1 minuto de descanso entre rondas.",
        ],
      },
    },
  },
  {
    slug: "elbow-space",
    level: "beginner",
    minutes: 5,
    focus: ["elbow"],
    shots: [],
    videoUrl: null,
    sort: 40,
    content: {
      en: {
        title: "Elbow Space Drill",
        summary: "Keep room between elbow and body all the way through the swing.",
        focusLabel: "Elbow position",
        steps: [
          "Hold a ball loosely between your elbow and ribs.",
          "Swing slowly: the ball should drop as the elbow moves away from the body at preparation.",
          "If the ball stays trapped, your elbow is tucked. Reset and repeat.",
          "3 sets of 10 slow swings, then 10 at normal speed.",
        ],
      },
      es: {
        title: "Espacio para el codo",
        summary: "Mantén espacio entre el codo y el cuerpo durante todo el golpe.",
        focusLabel: "Posición del codo",
        steps: [
          "Sujeta una bola sin apretar entre el codo y las costillas.",
          "Haz el swing despacio: la bola debe caer cuando el codo se separa del cuerpo en la preparación.",
          "Si la bola se queda atrapada, el codo va pegado. Vuelve a empezar.",
          "3 series de 10 swings lentos y luego 10 a velocidad normal.",
        ],
      },
    },
  },
  {
    slug: "racket-face-freeze",
    level: "beginner",
    minutes: 5,
    focus: ["racket"],
    shots: [],
    videoUrl: null,
    sort: 50,
    content: {
      en: {
        title: "Racket Face Freeze",
        summary: "Hold the face square to the target through contact.",
        focusLabel: "Racket face",
        steps: [
          "Hit an easy ball and freeze at contact.",
          "Check the face points at your target, not at the sky.",
          "Hold the finish for two seconds before resetting.",
          "15 forehands and 15 backhands.",
        ],
      },
      es: {
        title: "Congela la cara de la pala",
        summary: "Mantén la cara de la pala mirando al objetivo en el impacto.",
        focusLabel: "Cara de la pala",
        steps: [
          "Golpea una bola fácil y congela en el impacto.",
          "Comprueba que la cara de la pala mira al objetivo y no al cielo.",
          "Mantén el final dos segundos antes de volver a empezar.",
          "15 derechas y 15 revés.",
        ],
      },
    },
  },
  {
    slug: "wall-rotation",
    level: "intermediate",
    minutes: 10,
    focus: ["torso"],
    shots: ["forehand", "backhand", "drive"],
    videoUrl: null,
    sort: 60,
    content: {
      en: {
        title: "Wall Rally Rotation",
        summary: "Turn the shoulders early and finish facing the net.",
        focusLabel: "Torso rotation",
        steps: [
          "Rally gently against a wall from 4–5 metres.",
          "Turn your shoulders sideways as soon as you read the ball, before it bounces.",
          "Swing through and finish with your chest facing the wall.",
          "3 minutes forehand, 3 minutes backhand, 4 minutes alternating.",
        ],
      },
      es: {
        title: "Rotación contra la pared",
        summary: "Gira los hombros pronto y termina de cara a la red.",
        focusLabel: "Rotación del tronco",
        steps: [
          "Peloteo suave contra una pared a 4–5 metros.",
          "Gira los hombros de perfil en cuanto leas la bola, antes del bote.",
          "Acompaña el golpe y termina con el pecho de cara a la pared.",
          "3 minutos de derecha, 3 de revés y 4 alternando.",
        ],
      },
    },
  },
  {
    slug: "medicine-ball-turns",
    level: "beginner",
    minutes: 6,
    focus: ["torso"],
    shots: [],
    videoUrl: null,
    sort: 70,
    content: {
      en: {
        title: "Medicine Ball Turns",
        summary: "Train the hip-then-shoulder turn that powers every swing.",
        focusLabel: "Core rotation",
        steps: [
          "Stand side-on holding a light medicine ball (2–3 kg) at your back hip.",
          "Turn the hips first, then the shoulders, and release the ball toward a wall.",
          "Catch, reset, and repeat on the other side.",
          "3 sets of 8 each side.",
        ],
      },
      es: {
        title: "Giros con balón medicinal",
        summary: "Entrena el giro de cadera y luego hombros que da potencia al golpe.",
        focusLabel: "Rotación del core",
        steps: [
          "De perfil, sujeta un balón medicinal ligero (2–3 kg) a la altura de la cadera de atrás.",
          "Gira primero la cadera, luego los hombros, y suelta el balón hacia una pared.",
          "Recógelo, vuelve a la posición y repite hacia el otro lado.",
          "3 series de 8 por lado.",
        ],
      },
    },
  },
  {
    slug: "ladder-to-volley",
    level: "intermediate",
    minutes: 8,
    focus: ["foot"],
    shots: ["volley"],
    videoUrl: null,
    sort: 80,
    content: {
      en: {
        title: "Ladder Footwork to Volley",
        summary: "Quick feet into a balanced, wide base at the net.",
        focusLabel: "Footwork",
        steps: [
          "Run a short agility ladder (or 4 lines) toward the net.",
          "Out of the last rung, split step and widen your base to shoulder width or more.",
          "Volley the partner's feed, then backpedal to the start.",
          "4 rounds of 6 reps.",
        ],
      },
      es: {
        title: "Escalera de pies a volea",
        summary: "Pies rápidos hasta una base amplia y equilibrada en la red.",
        focusLabel: "Juego de pies",
        steps: [
          "Recorre una escalera de agilidad corta (o 4 líneas) hacia la red.",
          "Al salir del último peldaño, haz el split step y abre la base al ancho de hombros o más.",
          "Volea la bola de tu compañero y vuelve de espaldas al inicio.",
          "4 rondas de 6 repeticiones.",
        ],
      },
    },
  },
  {
    slug: "bandeja-shadow",
    level: "intermediate",
    minutes: 8,
    focus: ["elbow", "torso"],
    shots: ["bandeja", "vibora", "smash"],
    videoUrl: null,
    sort: 90,
    content: {
      en: {
        title: "Overhead Shadow Swings",
        summary: "Elbow high and shoulders turned before every overhead.",
        focusLabel: "Overhead shape",
        steps: [
          "Turn sideways with the non-racket hand pointing up at an imaginary ball.",
          "Lift the hitting elbow to shoulder height or above, racket behind the head.",
          "Swing through slowly, rotating the shoulders to face the net at the end.",
          "3 sets of 10.",
        ],
      },
      es: {
        title: "Golpes por alto en sombra",
        summary: "Codo alto y hombros girados antes de cada golpe por alto.",
        focusLabel: "Forma por alto",
        steps: [
          "Ponte de perfil con la mano libre señalando una bola imaginaria.",
          "Sube el codo de golpeo a la altura del hombro o más, con la pala detrás de la cabeza.",
          "Haz el golpe despacio, girando los hombros hasta mirar a la red al final.",
          "3 series de 10.",
        ],
      },
    },
  },
];
