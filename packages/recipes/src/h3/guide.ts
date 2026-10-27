/**
 * MiniMax H3's guides for the prompt designer: the family's (a shot with its sound and words), and the two for a clip whose
 * sound is a recording (card #129), Lip sync's and a clip the recording plays over (card #72). Every H3 form alike: the
 * lines they share are the same constants, word for word, so that a rule changed in one is changed in all.
 */

/** What Afflatus writes of H3's layout itself. */
const LAYOUT = "Afflatus adds the model's layout itself (field labels, the [Shot 1] mark, the picture alignment lines): write only the content of each part, never a label.";
const RULES = "RULES FOR THE PROMPT (the model's integrated description)";
/** The style sentence and the one shot, at a length in words. */
const shot = (words: string) => `- One short sentence of visual style first ("Live-action, cinematic, handheld, warm tungsten light."), then ONE continuous shot in the present tense, in the order things happen. ${words} words.`;
const LOOKS = "who is in it and how they look (hair, build, clothing with colour and material)";
const TIMING = `with timing words ("at first", "then", "as she…")`;
const CAMERA = `- The camera as type + amplitude + speed: "The camera pushes in with small amplitude at slow speed toward her face." One move per shot.`;
const CUT = `- A cut only when asked or past 9 seconds: "[Shot 2] At 00:05.000, the camera cuts to …".`;
const ON_SCREEN = "- Text that must appear on screen: English double quotes, word for word.";
const POSITIVE = `- Write what you WANT, never what you do not want: the model has no negative branch ("the street stays empty", not "no other people").`;
const FEW = "- A few actions, described precisely: more detail is not more actions.";
const PICTURES = `PICTURES
- A first frame: one clause of what it preserves, then ONLY what moves from there.
- A first and a last frame: the motion between them, never two still descriptions.
- Carrying on from another clip: the action continues, nothing resets; one short clause keeps the people the same.`;
const EXAMPLE = "EXAMPLE, for the form only (its subject, place, lens and words are not to be reused):";

/** The family's: a shot with its voices, words, sounds and music. */
export const H3_GUIDE = `MiniMax H3 makes the picture AND the sound (voices, effects, music) together. ${LAYOUT}
${RULES}
${shot("100 to 150")}
- Order inside the shot: framing, ${LOOKS}, the action beat by beat ${TIMING}, the camera, the words spoken, the sounds that happen in the shot.
${CAMERA}
${CUT}
- Voices numbered (S1), (S2) in order of appearance; describe a voice the first time it speaks (age, timbre, accent). The exact words inside <d>…</d> with the language first: <d>[English] Come here.</d>. Who speaks, their number and HOW stay outside the tags: The woman with a soft, husky voice (S1) says, warm and teasing: <d>[English] Come here.</d>
- The user's words stay as written, never translated. A voice from off screen: "says in an off-screen voiceover", lips closed.
${ON_SCREEN}
${POSITIVE}
${FEW}
THE OTHER PARTS
- "Sound effects": 1 to 4 sentences of ambience and physical sound, in order. Never dialogue, never music.
- "Music" (over the scene, unheard by the people in it): genre, tempo, instrumentation, dynamics. Never an artist or a song name. Leave it EMPTY for no music. A radio or singing in the scene goes in the Prompt.
${PICTURES}
${EXAMPLE}
Prompt: Live-action, cinematic. The young woman shown in the picture keeps her appearance, her clothing and her seat by the rain-covered train window. The camera trucks right with small amplitude at slow speed as she lifts her gaze from the folded letter toward the passing city lights. Her reflection slides across the glass while the quiet, breathy young woman (S1) says, almost to herself: <d>[English] I get off at the next station.</d> She folds the letter along its crease.
Sound effects: The train wheels keep a steady metallic rhythm under a low ventilation hum. Rain ticks against the window; paper rustles softly in her hands.
Music: Sustained cello notes at a slow tempo with widely spaced piano tones, slowly fading.`;

/** Never written under a recording: its words and its voice are the recording's. */
const NO_LINE = "Never write a spoken line, a <d>…</d> tag, a speaker number (S1) or what a voice sounds like: the recording is the words and the voice.";
/** The take's sound under a recording: H3's own is not kept after the part begins (shared/recording.ts). */
const RECORDED_PARTS = `THE OTHER PARTS
- The take's sound is the recording: H3's own sound is not kept. Leave "Music" EMPTY. "Sound effects": empty, or one sentence of the place's quiet ambience when the user asks for it. Never dialogue, never music.`;

/** Lip sync's: the scene and how the person speaks, the recording the words. */
export const H3_LIPSYNC_GUIDE = `MiniMax H3 makes the picture AND the sound together. In this clip the sound is a RECORDING, laid on it so that the mouth follows its words: the recording is what is said, and the text gives the scene and how the person speaks. ${LAYOUT}
${RULES}
${shot("60 to 120")}
- Order inside the shot: framing, ${LOOKS}, where they are, then how they speak beat by beat ${TIMING}: the tone, the expression, the gestures, where they look; the camera.
- The face of who speaks in frame for as long as they speak (a medium shot or closer), lit and turned toward the camera or in three-quarter view.
${CAMERA} The camera still or slow while they speak.
- ${NO_LINE} Say how they speak through the face and the body: "she speaks warmly to the camera, smiling between phrases, her hands opening as she makes her point".
${ON_SCREEN}
${POSITIVE}
${FEW}
${RECORDED_PARTS}
${PICTURES}
${EXAMPLE}
Prompt: Live-action, cinematic, soft overcast daylight. A medium close-up of the man shown in the picture, keeping his appearance and his grey wool coat, seated at a café terrace table. At first he looks down at his cup, then lifts his gaze to the camera and speaks calmly, a slight smile, his eyebrows rising between phrases. As he makes his point he opens one hand above the table, then leans back, still speaking, his eyes steady on the lens. The camera holds still at eye level.`;

/** A clip a recording plays over (card #72): the picture only, the people on screen silent under it. */
export const H3_OVER_GUIDE = `MiniMax H3 makes the picture AND the sound together. In this clip a RECORDING plays over the picture unchanged (a song, a voice-over, someone off screen) and is all that is heard: the text gives the picture, what is seen and what moves. ${LAYOUT}
${RULES}
${shot("60 to 120")}
- Order inside the shot: framing, ${LOOKS}, the action beat by beat ${TIMING}, the camera.
- The people on screen are silent under the recording: write them listening, watching, moving or playing, their lips closed ("she listens, her lips closed, swaying gently to the music"). ${NO_LINE}
${CAMERA}
${CUT}
${ON_SCREEN}
${POSITIVE}
${FEW}
${RECORDED_PARTS}
${PICTURES}
${EXAMPLE}
Prompt: Live-action, cinematic, warm dusk light. A wide shot of a narrow harbour street, fishing boats moored along the quay. The young woman shown in the picture keeps her appearance and her red scarf as she walks slowly along the water's edge, her lips closed, then stops and watches the boats rock. The camera trucks left with small amplitude at slow speed, keeping her in the left third of the frame.`;

/**
 * Motion transfer's (card #129), walking its boxes as Swap's does: the driving video gives the motion, the camera and the
 * timing, the picture everything seen, so the text only says who is there and what they do, short, in SCAIL-2's spirit.
 * Nothing of the room or the light: H3 draws every word ("Keep the room and the light…" drew a lamp, 2026-10-20).
 */
export const H3_MOTION_GUIDE = `A MOTION TRANSFER PROMPT is for MiniMax H3 held to a driving video's pose. It is not a scene: the motion, the gestures, the camera and the timing come from the video, and everything seen comes from the PICTURE, its first frame (its people, its room, its light). The text only helps H3 keep who is there and say what they do; short is best.
- THE PARTS come first: write "How they look" (the person of the picture in a few words, the things that can be seen: hair, clothing with its colour; "short brown hair, a white shirt and jeans") and "What happens" (in this part, present tense, one short sentence, the action the way the video has it: "He dances in the living room, turning on the spot and raising his arms."). Leave "Prompt as sent" empty: Afflatus writes it from the parts, the shot's words first. Write "Prompt as sent" only when the user asks for a whole prompt of their own: then 25 to 60 words, plain sentences, present tense, who is in the picture and what they do, and the rules below are its rules.
- "How they look" is shared by every window of a source on a timeline: keep it the same from window to window. "What happens" is each window's own.
- The action in a few words, as the video has it. Never a sequence of moves, a camera move or timing: the video gives those.
- Only what the picture shows. Never the room, the light or a new person, object or place: the picture has them, and H3 draws what is named.
${POSITIVE}
- The sound is the driving video's (Keep the source's sound) and the mouth is drawn to it: never write a spoken line, a <d>…</d> tag, a speaker number (S1) or what a voice sounds like.
- No names of real people, no weights, no quality words, no tags.
- You cannot see the picture or the video: take what they show from the user's words, never invent a look. When you do not know who is in the picture, ask ONE question.`;
