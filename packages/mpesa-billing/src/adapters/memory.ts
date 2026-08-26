/**
 * In-memory store — tests and local development.
 *
 * The compare-and-swap is trivially atomic here because Node runs one
 * callback at a time; the Postgres adapter is where that guarantee has to be
 * earned. Nothing survives a restart, so never point production at this.
 */

import type { BillingPayment, MpesaEnvironment, Rail } from '../types.js'
import type { ApplyInTransaction, BillingStore, CachedToken, SettleUpdates } from './types.js'

function key(rail: Rail, providerRef: string): string {
  return `${rail}:${providerRef}`
}

export class MemoryStore implements BillingStore {
  private readonly payments = new Map<string, BillingPayment>()
  private readonly tokens = new Map<MpesaEnvironment, CachedToken>()

  async createPayment(payment: BillingPayment): Promise<BillingPayment | null> {
    const id = key(payment.rail, payment.providerRef)
    if (this.payments.has(id)) return null
    const stored = { ...payment }
    this.payments.set(id, stored)
    return { ...stored }
  }

  async getPayment(rail: Rail, providerRef: string): Promise<BillingPayment | null> {
    const found = this.payments.get(key(rail, providerRef))
    return found ? { ...found } : null
  }

  async getPaymentByReference(rail: Rail, reference: string): Promise<BillingPayment | null> {
    for (const payment of this.payments.values()) {
      if (payment.rail === rail && payment.reference === reference) return { ...payment }
    }
    return null
  }

  async settlePayment(
    rail: Rail,
    providerRef: string,
    updates: SettleUpdates,
    apply?: ApplyInTransaction,
  ): Promise<BillingPayment | null> {
    const stored = this.payments.get(key(rail, providerRef))
    // Unknown, or already terminal — the duplicate-delivery case.
    if (!stored || stored.status !== 'PENDING') return null

    // Spread `updates` field by field: `settledAmount: undefined` from an
    // object spread would erase a value the Postgres adapter's COALESCE keeps.
    const settled: BillingPayment = {
      ...stored,
      status: updates.status,
      settledAt: new Date(),
      ...(updates.receipt !== undefined ? { receipt: updates.receipt } : {}),
      ...(updates.payerRef !== undefined ? { payerRef: updates.payerRef } : {}),
      ...(updates.settledAmount !== undefined ? { settledAmount: updates.settledAmount } : {}),
      ...(updates.failureCode !== undefined ? { failureCode: updates.failureCode } : {}),
      ...(updates.failureReason !== undefined ? { failureReason: updates.failureReason } : {}),
      ...(updates.raw !== undefined ? { raw: updates.raw } : {}),
    }
    this.payments.set(key(rail, providerRef), settled)

    // No transaction to roll back to, so restore the previous state by hand:
    // a throwing `apply` must not leave the payment settled.
    if (apply) {
      try {
        await apply({ ...settled }, undefined)
      } catch (error) {
        this.payments.set(key(rail, providerRef), stored)
        throw error
      }
    }

    return { ...settled }
  }

  async recordSettledPayment(
    payment: BillingPayment,
    apply?: ApplyInTransaction,
  ): Promise<BillingPayment | null> {
    const id = key(payment.rail, payment.providerRef)
    if (this.payments.has(id)) return null

    const stored: BillingPayment = {
      ...payment,
      settledAmount: payment.settledAmount ?? payment.amount,
      settledAt: payment.settledAt ?? new Date(),
    }
    this.payments.set(id, stored)

    if (apply) {
      try {
        await apply({ ...stored }, undefined)
      } catch (error) {
        this.payments.delete(id)
        throw error
      }
    }

    return { ...stored }
  }

  async getCachedToken(environment: MpesaEnvironment, validAt: Date): Promise<CachedToken | null> {
    const token = this.tokens.get(environment)
    if (!token || token.expiresAt <= validAt) return null
    return { ...token }
  }

  async putCachedToken(environment: MpesaEnvironment, token: CachedToken): Promise<void> {
    this.tokens.set(environment, { ...token })
  }

  /** Test helper: every payment recorded so far. */
  all(): BillingPayment[] {
    return [...this.payments.values()].map((payment) => ({ ...payment }))
  }
}
