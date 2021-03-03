import { concat, merge, of, race, timer } from "rxjs"
import {
  distinctUntilChanged,
  exhaustMap,
  filter,
  groupBy,
  map,
  mapTo,
  mergeMap,
  switchMap,
  take,
  withLatestFrom,
} from "rxjs/operators"
import {
  collect,
  createListener,
  getGroupedObservable,
} from "@react-rxjs/utils"
import { rfq$, RfqResponse } from "services/rfqs"
import { getNotional$, getTileState$, TileStates } from "../Tile.state"
import { symbolBind } from "../Tile.context"
import { equals } from "utils"

export const [useIsRfq, isRfq$] = symbolBind(
  (symbol: string) =>
    getNotional$(symbol).pipe(
      map((notional) => Number(notional) >= 10_000_000),
      distinctUntilChanged(),
    ),
  false,
)

export enum QuoteState {
  Init,
  Requested,
  Received,
  Rejected,
}

const createSymbolSignal = () => {
  const [input$, onInput] = createListener<string>()
  const source$ = input$.pipe(
    groupBy((x) => x),
    collect(),
  )
  return [(key: string) => getGroupedObservable(source$, key), onInput] as const
}

const [getRejection$, onRejection] = createSymbolSignal()
const [getRequestCancellation$, onCancelRequest] = createSymbolSignal()
const [getQuoteRequested$, onQuoteRequest] = createSymbolSignal()

export { onRejection, onCancelRequest, onQuoteRequest }

const INIT = { state: QuoteState.Init as const }
const REQUESTED = { state: QuoteState.Requested as const }

const [, _getRfqState$] = symbolBind((symbol) =>
  getQuoteRequested$(symbol).pipe(
    withLatestFrom(getNotional$(symbol).pipe(map(Number))),
    exhaustMap(([, notional]) =>
      concat(
        of(REQUESTED),
        race([
          getRequestCancellation$(symbol).pipe(take(1), mapTo(INIT)),
          rfq$({ symbol, notional }).pipe(
            mergeMap((payload) =>
              concat(
                of({ state: QuoteState.Received as const, payload }),
                race([
                  getTileState$(symbol).pipe(
                    filter((x) => x.status !== TileStates.Ready),
                    take(1),
                    mapTo(INIT),
                  ),
                  merge(getRejection$(symbol), timer(payload.timeout)).pipe(
                    take(1),
                    mapTo({
                      state: QuoteState.Rejected as const,
                      payload,
                    }),
                  ),
                ]),
              ),
            ),
          ),
        ]),
      ),
    ),
  ),
)

export const [useRfqState, getRfqState$] = symbolBind(
  (symbol) =>
    isRfq$(symbol).pipe(
      switchMap((isRfq) => (isRfq ? _getRfqState$(symbol) : of(INIT))),
    ),
  INIT,
)

export const [useRfqPayload, getRfqPayload$] = symbolBind(
  (symbol) =>
    getRfqState$(symbol).pipe(
      map((rfq) =>
        rfq.state === QuoteState.Init || rfq.state === QuoteState.Requested
          ? null
          : {
              isExpired: rfq.state === QuoteState.Rejected,
              rfqResponse: rfq.payload,
            },
      ),
      distinctUntilChanged(equals),
    ),
  null as null | { isExpired: boolean; rfqResponse: RfqResponse },
)
