/*
 * The built-ins that admission, predicate compilation, aggregation, transaction
 * lifecycle, commit deadlines and result sizing call (clocks, timers and
 * promise settlement included), captured once when the package loads and
 * called only through the captured `Reflect.apply`. Descriptors handed to
 * `Object.defineProperty` have no prototype. So a later replacement of a
 * global or an inherited method, or an `Object.prototype` member such as
 * `get`, `set` or `value`, cannot change what these paths admit or return, or
 * make them fail untyped. `test/intrinsics-guard.test.js` keeps their callers
 * on these captures.
 */
export const apply = Reflect.apply, ownKeys = Reflect.ownKeys;
export const { create: createObject, defineProperty, freeze, getOwnPropertyDescriptor: ownDescriptor, getPrototypeOf: prototypeOf,
  hasOwn } = Object;
export const isArray = Array.isArray, ArrayPrototype = Array.prototype, ObjectPrototype = Object.prototype;
export const isSafeInteger = Number.isSafeInteger, isFiniteNumber = Number.isFinite;
export const NativeNumber = Number, NativeBigInt = BigInt, NativeDate = Date, NativeMap = Map, NativeWeakMap = WeakMap;
export const NativeDateTimeFormat = Intl.DateTimeFormat;
export const { min, max, ceil } = Math;
export const NativePromise = Promise;
const nativeThen = Promise.prototype.then;
const nativeSetTimeout = setTimeout, nativeClearTimeout = clearTimeout;
const NativeJSON = JSON, nativeParse = JSON.parse, nativeStringify = JSON.stringify;
const NativeBuffer = Buffer, nativeByteLength = Buffer.byteLength;
const clock = performance, nativeNow = performance.now, nativeDateNow = Date.now;
const nativeJoin = Array.prototype.join;
const nativeMapGet = Map.prototype.get, nativeMapSet = Map.prototype.set, nativeMapHas = Map.prototype.has;
const nativeMapClear = Map.prototype.clear, nativeMapForEach = Map.prototype.forEach;
const nativeWeakGet = WeakMap.prototype.get, nativeWeakSet = WeakMap.prototype.set;
const nativeSetHas = Set.prototype.has, nativeSetAdd = Set.prototype.add, nativeSetDelete = Set.prototype.delete;
const nativeSetClear = Set.prototype.clear, nativeSetForEach = Set.prototype.forEach;

/** Append as an own data slot, never through an inherited push, index setter or descriptor member. */
export const append = <T>(values: T[], value: T): void => {
  defineProperty(values, values.length, { __proto__: null, value, writable: true, configurable: true, enumerable: true } as PropertyDescriptor);
};
export const joined = (values: readonly string[], separator: string) => apply(nativeJoin, values, [separator]) as string;
export const parseJson = (text: string): unknown => apply(nativeParse, NativeJSON, [text]);
/** A primitive's JSON text: JSON.stringify consults no toJSON for a string, number, boolean or null. */
export const primitiveJson = (value: string | number | boolean | null) => apply(nativeStringify, NativeJSON, [value]) as string;
/** UTF-8 bytes of text, a lone surrogate counted as its 3-byte replacement: the native count, captured at load. */
export const utf8Bytes = (text: string) => apply(nativeByteLength, NativeBuffer, [text]) as number;
export const monotonicNow = () => apply(nativeNow, clock, []) as number;
export const wallNow = () => apply(nativeDateNow, NativeDate, []) as number;
export const mapGet = <K, V>(map: ReadonlyMap<K, V>, key: K) => apply(nativeMapGet, map, [key]) as V | undefined;
export const mapSet = <K, V>(map: Map<K, V>, key: K, value: V): void => { apply(nativeMapSet, map, [key, value]); };
export const mapHas = <K, V>(map: ReadonlyMap<K, V>, key: K) => apply(nativeMapHas, map, [key]) as boolean;
export const mapClear = <K, V>(map: Map<K, V>): void => { apply(nativeMapClear, map, []); };
export const mapForEach = <K, V>(map: ReadonlyMap<K, V>, f: (value: V, key: K) => void): void => { apply(nativeMapForEach, map, [f]); };
export const weakGet = <K extends object, V>(map: WeakMap<K, V>, key: K) => apply(nativeWeakGet, map, [key]) as V | undefined;
export const weakSet = <K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void => { apply(nativeWeakSet, map, [key, value]); };
export const setHas = <T>(set: ReadonlySet<T>, value: T) => apply(nativeSetHas, set, [value]) as boolean;
export const setAdd = <T>(set: Set<T>, value: T): void => { apply(nativeSetAdd, set, [value]); };
export const setDelete = <T>(set: Set<T>, value: T): void => { apply(nativeSetDelete, set, [value]); };
export const setClear = <T>(set: Set<T>): void => { apply(nativeSetClear, set, []); };
/** `promise.then(fulfilled, rejected)` through the native method. */
export const settle = <T>(promise: Promise<T>, fulfilled?: (value: T) => unknown, rejected?: (error: unknown) => unknown) =>
  apply(nativeThen, promise, [fulfilled, rejected]) as Promise<unknown>;
/** Settle as the first of `promises` settles, as `Promise.race` does, through the native `then`. */
export const race = <T>(promises: readonly Promise<T>[]) => new NativePromise<T>((resolve, reject) => {
  for (let i = 0; i < promises.length; i++) settle(promises[i], resolve, reject);
});
export const startTimer = (callback: () => void, ms: number) => nativeSetTimeout(callback, ms);
export const stopTimer = (timer: ReturnType<typeof setTimeout> | undefined): void => { nativeClearTimeout(timer); };
export const setForEach = <T>(set: ReadonlySet<T>, f: (value: T) => void): void => { apply(nativeSetForEach, set, [f]); };
