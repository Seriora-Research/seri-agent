import { tuiReducer, type Dispatch, type TuiState } from "./reducer";

export const STREAM_TOKEN_PAINT_MS = 150;

export function createStreamDispatch(
  setState: (updater: (state: TuiState) => TuiState) => void,
): {
  dispatch: Dispatch;
  getPendingLiveOutputEstimate: () => number;
  subscribe: (listener: () => void) => () => void;
} {
  const dispatch: Dispatch = (action) => {
    setState((state) => tuiReducer(state, action));
  };
  return {
    dispatch,
    getPendingLiveOutputEstimate: () => 0,
    subscribe: () => () => {},
  };
}
