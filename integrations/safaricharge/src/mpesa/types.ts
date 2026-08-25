/**
 * Daraja callback shapes.
 *
 * Modelled on what the API actually sends rather than what the docs promise:
 * `CallbackMetadata` is present only on success, item values are absent for
 * fields Safaricom masks (the customer phone number is masked in 2026+
 * callbacks), and `ResultCode` is a number on the STK callback but a string
 * on the C2B ones.
 */

export interface MpesaCallbackMetadataItem {
  Name: string;
  Value?: string | number;
}

export interface MpesaStkCallbackSuccess {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResultCode: 0;
  ResultDesc: string;
  CallbackMetadata?: { Item: MpesaCallbackMetadataItem[] };
}

export interface MpesaStkCallbackFailure {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResultCode: number;
  ResultDesc: string;
}

export type MpesaStkCallback = MpesaStkCallbackSuccess | MpesaStkCallbackFailure;

export interface MpesaCallbackBody {
  Body: { stkCallback: MpesaStkCallback };
}

/** Payload on the B2C queue-timeout URL — shape varies; treat every field as optional. */
export interface B2CTimeoutPayload {
  ConversationID?: string;
  OriginatorConversationID?: string;
  Result?: {
    ConversationID?: string;
    OriginatorConversationID?: string;
    ResultDesc?: string;
  };
}
