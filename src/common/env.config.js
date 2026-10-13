/**
 * Build-time configuration, generated from `.env` by `npm run config`.
 *
 * DO NOT EDIT BY HAND — the next `npm run config` overwrites it. Edit `.env`
 * (see `.env.example`) and regenerate.
 *
 * Nothing here is a secret, and nothing here authorizes anything: `ADMIN_EMAIL`
 * only pre-fills a form, and the backend decides permissions on every request.
 */

/**
 * The administrator's email, for pre-filling the admin sign-in form.
 *
 * It has to match the account the SERVER holds, because that is how the server
 * looks the administrator up: a near-miss address (one letter out) is not a
 * cosmetic difference, it is `401 invalid_credentials` for every correct
 * password. This is the address the backend itself is provisioned with — keep
 * both sides in step, and check `SUPER_ADMIN_EMAIL` if sign-in is ever refused.
 */
export const ADMIN_EMAIL = "studymuddassir@gmail.com";

/** The backend this build points at, or null to use the shipped default. */
export const API_BASE = null;
