export const deferred = () => Promise.withResolvers();

export const immediate = () => new Promise(resolve => setImmediate(resolve));

export function replace(object, method, value) {
  const original = Object.getOwnPropertyDescriptor(object, method);
  Object.defineProperty(object, method, { configurable: true, value });
  return () => original ? Object.defineProperty(object, method, original) : Reflect.deleteProperty(object, method);
}
