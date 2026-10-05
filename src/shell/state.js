import { libraryState } from "../features/library/store.js";
import { chatState } from "../features/chat/store.js";

// Compatibility projection: existing panels retain their property API while
// ownership lives in the feature stores. New features import their own store.
export const state = {};
for (const store of [libraryState, chatState]) for (const key of Object.keys(store)) {
  Object.defineProperty(state, key, { enumerable: true,
    get: () => store[key], set: value => { store[key] = value; } });
}
