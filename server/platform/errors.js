export const fault = (message, status = 400) => Object.assign(new Error(message), { status });
