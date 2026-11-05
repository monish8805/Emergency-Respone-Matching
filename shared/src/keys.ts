export const REQUEST_PREFIX = "request:";
export const RESOURCE_PREFIX = "resource:";

export const requestKey = (id: string) => `${REQUEST_PREFIX}${id}`;
export const resourceKey = (id: string) => `${RESOURCE_PREFIX}${id}`;
