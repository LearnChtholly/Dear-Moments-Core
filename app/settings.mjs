import { compatibilityDefaults } from "./legacy-settings.mjs";
const active = [
  "character",
  "memoryModel",
  "memoryPolicy",
  "memorySupervisor",
  "diary",
];
export const defaults = Object.fromEntries(
  Object.entries(compatibilityDefaults).filter(([key]) => active.includes(key)),
);
defaults.character = Object.fromEntries(
  Object.entries(defaults.character).filter(
    ([key]) => !["asset", "dragAsset", "renderer", "scale"].includes(key),
  ),
);
export const legacyDefaults = Object.fromEntries(
  Object.entries(compatibilityDefaults).filter(
    ([key]) => !active.includes(key),
  ),
);
