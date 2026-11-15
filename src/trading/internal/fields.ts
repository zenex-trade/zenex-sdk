/**
 * @internal The guard of a constructor that takes one fields object.
 *
 * A typed caller cannot omit a required field, but an untyped one can, and
 * a positional call from before 1.0.0 passes no object at all. Either would
 * otherwise build an object of `undefined` fields, or fail later with an
 * error that names neither the class nor the field.
 *
 * @param type The class name, for the message.
 * @param usage How to call the constructor, for the message.
 * @param required The fields that must be present, in declaration order.
 * @throws {TypeError} if `fields` is not an object, or naming the first
 *   field of `required` that is absent or `undefined`.
 */
export function requireFields<T extends object>(
    type: string,
    usage: string,
    fields: T,
    required: readonly (keyof T & string)[],
): void {
    if (typeof fields !== 'object' || fields === null) {
        throw new TypeError(`new ${type}() takes one fields object: ${usage}`);
    }
    for (const name of required) {
        if (fields[name] === undefined) {
            throw new TypeError(`new ${type}() is missing the required field '${name}'`);
        }
    }
}
