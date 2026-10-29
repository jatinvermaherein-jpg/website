// argon2id for passwords.
import { hash, verify } from '@node-rs/argon2';

export const hashPassword = (password: string): Promise<string> => hash(password);
export const verifyPassword = (password: string, stored: string): Promise<boolean> => verify(stored, password);
