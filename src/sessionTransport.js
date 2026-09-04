import { state } from "./app.js";
import { createSessionEventChannel } from "./sessionEventChannel.js";

let transport;
const getTransport = () => transport ||= createSessionEventChannel({ state });
export const connectSessionEvents = (...args) => getTransport().connectSessionEvents(...args);
export const closeSessionEvents = () => getTransport().closeSessionEvents();
export const waitOperation = id => getTransport().waitOperation(id);
