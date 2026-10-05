/* tslint:disable */
/* eslint-disable */

export function aggregate(signing_pkg: string, shares: string, public_key_package: string, alpha_hex: string): string;

export function dkgPart1(me: number): string;

export function dkgPart2(secret1: string, round1: string): string;

export function dkgPart3(secret2: string, round1: string, round2: string): string;

export function reviewPayout(pczt_b64: string, group_key: string, deal_id: string, network: string, expected_to: string): string;

export function signCommit(key_package: string): string;

export function signShare(signing_pkg: string, nonces: string, key_package: string, alpha_hex: string): string;

export function signingPackage(commitments: string, message_hex: string): string;

export function verify(public_key_package: string, alpha_hex: string, message_hex: string, sig_hex: string): boolean;
