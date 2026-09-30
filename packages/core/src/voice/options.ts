/** Choices for an agent's voice (Sarvam Bulbul v2). Pure, shared by the API and the dashboard. */
export const VOICE_LANGUAGES = [
  { code: "en-IN", name: "English" },
  { code: "hi-IN", name: "Hindi" },
  { code: "bn-IN", name: "Bengali" },
  { code: "ta-IN", name: "Tamil" },
  { code: "te-IN", name: "Telugu" },
  { code: "kn-IN", name: "Kannada" },
  { code: "ml-IN", name: "Malayalam" },
  { code: "mr-IN", name: "Marathi" },
  { code: "gu-IN", name: "Gujarati" },
  { code: "pa-IN", name: "Punjabi" },
  { code: "od-IN", name: "Odia" },
] as const;

export const VOICE_SPEAKERS = [
  { id: "anushka", name: "Anushka (female)" },
  { id: "manisha", name: "Manisha (female)" },
  { id: "vidya", name: "Vidya (female)" },
  { id: "arya", name: "Arya (female)" },
  { id: "abhilash", name: "Abhilash (male)" },
  { id: "karun", name: "Karun (male)" },
  { id: "hitesh", name: "Hitesh (male)" },
] as const;
