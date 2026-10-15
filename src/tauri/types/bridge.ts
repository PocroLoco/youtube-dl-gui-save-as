/** A download sent from the browser extension (or an ovd-save-as:// link). */
export type BridgeRequest = {
  requestId: string;
  url: string;
  audioOnly: boolean;
  windowWasVisible: boolean;
  windowWasFocused: boolean;
};

export type BridgeItemState
  = | 'fetching'
    | 'choosing'
    | 'saveAs'
    | 'ready'
    | 'downloading'
    | 'paused'
    | 'done'
    | 'error'
    | 'cancelled';

/** One download as the browser extension sees it. */
export type BridgeItem = {
  id: string;
  requestId?: string;
  title?: string;
  url?: string;
  thumbnail?: string;
  state: BridgeItemState;
  stage?: string;
  percent?: number;
  speedBps?: number;
  etaSecs?: number;
  done?: number;
  total?: number;
  /** Stays in the app; the extension only ever gets the file's name. */
  path?: string;
  error?: string;
};
