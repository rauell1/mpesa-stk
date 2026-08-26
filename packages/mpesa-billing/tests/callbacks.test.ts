import { describe, it, expect } from 'vitest'
import {
  parseB2CResult,
  parseB2CTimeout,
  parseC2B,
  parseStkCallback,
} from '../src/callbacks.js'

// Shapes taken from what Daraja actually sends, including the ones the docs
// do not mention: no CallbackMetadata on failure, a masked phone number, and
// a B2C timeout that is sometimes flat and sometimes wrapped.

describe('parseStkCallback', () => {
  it('reads a success, including the receipt', () => {
    const parsed = parseStkCallback({
      Body: {
        stkCallback: {
          MerchantRequestID: '29115-34620561-1',
          CheckoutRequestID: 'ws_CO_191220191020363925',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 1 },
              { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
              { Name: 'TransactionDate', Value: 20191219102115 },
              { Name: 'PhoneNumber', Value: 254708374149 },
            ],
          },
        },
      },
    })

    expect(parsed).toMatchObject({
      checkoutRequestId: 'ws_CO_191220191020363925',
      succeeded: true,
      resultCode: 0,
      receipt: 'NLJ7RT61SV',
      phoneNumber: '254708374149',
      amount: '1',
    })
  })

  it('reads a failure, which carries no CallbackMetadata at all', () => {
    const parsed = parseStkCallback({
      Body: {
        stkCallback: {
          MerchantRequestID: '29115-34620561-1',
          CheckoutRequestID: 'ws_CO_191220191020363925',
          ResultCode: 1032,
          ResultDesc: 'Request cancelled by user',
        },
      },
    })

    expect(parsed).toMatchObject({ succeeded: false, resultCode: 1032, resultDesc: 'Request cancelled by user' })
    expect(parsed?.receipt).toBeUndefined()
  })

  it('survives a masked phone number — the item is present with no Value', () => {
    const parsed = parseStkCallback({
      Body: {
        stkCallback: {
          CheckoutRequestID: 'ws_CO_1',
          ResultCode: 0,
          ResultDesc: 'ok',
          CallbackMetadata: {
            Item: [{ Name: 'MpesaReceiptNumber', Value: 'ABC123' }, { Name: 'PhoneNumber' }],
          },
        },
      },
    })

    expect(parsed?.receipt).toBe('ABC123')
    expect(parsed?.phoneNumber).toBeUndefined()
  })

  it.each([
    ['null', null],
    ['an empty object', {}],
    ['a body with no stkCallback', { Body: {} }],
    ['a callback with no CheckoutRequestID', { Body: { stkCallback: { ResultCode: 0 } } }],
    ['a callback with a non-numeric ResultCode', { Body: { stkCallback: { CheckoutRequestID: 'x', ResultCode: '0' } } }],
  ])('returns null for %s rather than throwing', (_label, payload) => {
    expect(parseStkCallback(payload)).toBeNull()
  })
})

describe('parseC2B', () => {
  it('reads the account number as the reference and joins the payer name', () => {
    const parsed = parseC2B({
      TransID: 'RKTQDM7W6S',
      TransAmount: '500.00',
      BillRefNumber: ' ORDER-42 ',
      MSISDN: '254708374149',
      FirstName: 'John',
      MiddleName: 'K',
      LastName: 'Doe',
    })

    expect(parsed).toEqual({
      transId: 'RKTQDM7W6S',
      reference: 'ORDER-42',
      amount: '500.00',
      msisdn: '254708374149',
      payerName: 'John K Doe',
    })
  })

  it('accepts a numeric TransAmount without turning it into a float', () => {
    expect(parseC2B({ TransID: 'T1', TransAmount: 500, BillRefNumber: 'R', MSISDN: '254700000000' })?.amount).toBe('500')
  })

  it.each([
    ['a blank account number', { TransID: 'T1', TransAmount: '1', BillRefNumber: '   ', MSISDN: 'x' }],
    ['a missing TransID', { TransAmount: '1', BillRefNumber: 'R', MSISDN: 'x' }],
    ['a missing amount', { TransID: 'T1', BillRefNumber: 'R', MSISDN: 'x' }],
  ])('returns null for %s', (_label, payload) => {
    expect(parseC2B(payload)).toBeNull()
  })
})

describe('parseB2CResult', () => {
  it('reads a successful payout', () => {
    const parsed = parseB2CResult({
      Result: {
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        ConversationID: 'AG_20191219_00005797af5d7d75f652',
        TransactionID: 'NLJ41HAY6Q',
      },
    })

    expect(parsed).toMatchObject({ succeeded: true, receipt: 'NLJ41HAY6Q' })
  })

  it('reads a failure and keeps the code Daraja gave', () => {
    const parsed = parseB2CResult({
      Result: { ResultCode: 2001, ResultDesc: 'The initiator information is invalid.', ConversationID: 'AG_1' },
    })

    expect(parsed).toMatchObject({ succeeded: false, resultCode: 2001 })
  })

  it('returns null when there is no ConversationID to key on', () => {
    expect(parseB2CResult({ Result: { ResultCode: 0 } })).toBeNull()
  })
})

describe('parseB2CTimeout', () => {
  it('reads the flat shape', () => {
    expect(parseB2CTimeout({ ConversationID: 'AG_1' })).toEqual({ conversationId: 'AG_1' })
  })

  it('reads the wrapped shape', () => {
    expect(parseB2CTimeout({ Result: { ConversationID: 'AG_2' } })).toEqual({ conversationId: 'AG_2' })
  })

  it('returns null when neither is present', () => {
    expect(parseB2CTimeout({ Result: {} })).toBeNull()
  })
})
