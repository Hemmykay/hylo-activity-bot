/**
 * Minimal Anchor/Borsh account decoder, driven directly by an Anchor IDL's
 * `types` array — no @coral-xyz/anchor dependency needed for read-only
 * decoding of a handful of account shapes.
 *
 * Borsh encodes a struct as its fields, in declared order, back-to-back with
 * no padding — so decoding is just "walk the field list, consume bytes for
 * each type, recurse into nested `defined` types the same way". This only
 * supports the type shapes actually used by the accounts this bot reads
 * (see hylo-accounts.service.ts) — vec/enum support can be added if a future
 * account needs it, but deliberately isn't guessed at here.
 */
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('idl-decoder');

export type IdlPrimitive = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'i64' | 'bool' | 'pubkey' | 'string';

export type IdlType =
  | IdlPrimitive
  | { array: [IdlType, number] }
  | { option: IdlType }
  | { defined: { name: string } };

export interface IdlField {
  name: string;
  type: IdlType;
}

export interface IdlStructType {
  kind: 'struct';
  fields?: IdlField[];
}

export interface IdlTypeDef {
  name: string;
  type: IdlStructType;
}

export interface HyloIdl {
  address: string;
  accounts: Array<{ name: string; discriminator: number[] }>;
  types: IdlTypeDef[];
}

export type DecodedValue = number | bigint | boolean | string | null | DecodedValue[] | { [key: string]: DecodedValue };
export type DecodedStruct = { [key: string]: DecodedValue };

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Minimal base58 encoder (Bitcoin/Solana alphabet) — only used for logging/verifying decoded pubkeys, never for arithmetic. */
function base58Encode(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString('hex') || '0'}`);
  const base = BigInt(58);
  let out = '';
  while (value > 0n) {
    const rem = value % base;
    out = BASE58_ALPHABET[Number(rem)] + out;
    value /= base;
  }
  for (const byte of bytes) {
    if (byte === 0) out = `${BASE58_ALPHABET[0]}${out}`;
    else break;
  }
  return out || BASE58_ALPHABET[0]!;
}

function readPrimitive(prim: IdlPrimitive, buf: Buffer, offset: number): { value: DecodedValue; offset: number } {
  switch (prim) {
    case 'u8': return { value: buf.readUInt8(offset), offset: offset + 1 };
    case 'i8': return { value: buf.readInt8(offset), offset: offset + 1 };
    case 'u16': return { value: buf.readUInt16LE(offset), offset: offset + 2 };
    case 'i16': return { value: buf.readInt16LE(offset), offset: offset + 2 };
    case 'u32': return { value: buf.readUInt32LE(offset), offset: offset + 4 };
    case 'i32': return { value: buf.readInt32LE(offset), offset: offset + 4 };
    case 'u64': return { value: buf.readBigUInt64LE(offset), offset: offset + 8 };
    case 'i64': return { value: buf.readBigInt64LE(offset), offset: offset + 8 };
    case 'bool': return { value: buf.readUInt8(offset) !== 0, offset: offset + 1 };
    case 'pubkey': return { value: base58Encode(buf.subarray(offset, offset + 32)), offset: offset + 32 };
    case 'string': {
      const len = buf.readUInt32LE(offset);
      const value = buf.subarray(offset + 4, offset + 4 + len).toString('utf8');
      return { value, offset: offset + 4 + len };
    }
  }
}

function decodeType(idl: HyloIdl, ty: IdlType, buf: Buffer, offset: number): { value: DecodedValue; offset: number } {
  if (typeof ty === 'string') return readPrimitive(ty, buf, offset);

  if ('array' in ty) {
    const [elemType, len] = ty.array;
    const out: DecodedValue[] = [];
    let o = offset;
    for (let i = 0; i < len; i++) {
      const r = decodeType(idl, elemType, buf, o);
      out.push(r.value);
      o = r.offset;
    }
    return { value: out, offset: o };
  }

  if ('option' in ty) {
    const flag = buf.readUInt8(offset);
    if (flag === 0) return { value: null, offset: offset + 1 };
    return decodeType(idl, ty.option, buf, offset + 1);
  }

  if ('defined' in ty) {
    return decodeDefinedType(idl, ty.defined.name, buf, offset);
  }

  throw new Error(`Unsupported IDL type shape: ${JSON.stringify(ty)}`);
}

function decodeDefinedType(idl: HyloIdl, name: string, buf: Buffer, offset: number): { value: DecodedStruct; offset: number } {
  const typeDef = idl.types.find((t) => t.name === name);
  if (!typeDef) throw new Error(`IDL type not found: ${name}`);
  if (typeDef.type.kind !== 'struct') throw new Error(`Unsupported IDL type kind for ${name}: ${typeDef.type.kind}`);

  const out: DecodedStruct = {};
  let o = offset;
  for (const field of typeDef.type.fields ?? []) {
    const r = decodeType(idl, field.type, buf, o);
    out[field.name] = r.value;
    o = r.offset;
  }
  return { value: out, offset: o };
}

/** Decodes a full Anchor account: skips the 8-byte discriminator, then decodes `accountTypeName`'s struct fields in order. */
export function decodeAccount(idl: HyloIdl, accountTypeName: string, data: Buffer): DecodedStruct {
  const { value } = decodeDefinedType(idl, accountTypeName, data, 8);
  logger.debug({ accountTypeName, bytesConsumed: data.length }, 'Account decoded');
  return value;
}

function isDecodedStruct(v: DecodedValue): v is DecodedStruct {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Reads a nested struct field by dotted path, e.g. "virtual_stablecoin.supply.bits" — throws with the exact failing segment if the shape doesn't match. */
export function getPath(value: DecodedStruct, path: string): DecodedValue {
  const segments = path.split('.');
  let current: DecodedValue = value;
  for (const segment of segments) {
    if (!isDecodedStruct(current) || !(segment in current)) {
      throw new Error(`Path "${path}" not found at segment "${segment}"`);
    }
    current = current[segment]!;
  }
  return current;
}

/** Converts a decoded `UFixValue64 { bits: u64, exp: i8 }` field to a plain JS number: bits * 10^exp. */
export function ufixValue64ToNumber(value: DecodedValue): number {
  if (!isDecodedStruct(value) || typeof value.bits !== 'bigint' || typeof value.exp !== 'number') {
    throw new Error(`Expected a UFixValue64-shaped value, got: ${JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  }
  return Number(value.bits) * Math.pow(10, value.exp);
}
