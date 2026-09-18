(function initializeLectureProtocol(root) {
  if (root.LectureProtocol) return;

  const TARGET = Object.freeze({
    SERVICE_WORKER: "service-worker",
    OFFSCREEN: "offscreen",
    SIDEPANEL: "sidepanel",
    CONTENT: "content"
  });

  const MESSAGE = Object.freeze({
    START_SESSION: "START_SESSION",
    UPDATE_GEMINI_KEY: "UPDATE_GEMINI_KEY",
    STOP_SESSION: "STOP_SESSION",
    GET_SESSION_SNAPSHOT: "GET_SESSION_SNAPSHOT",
    SESSION_SNAPSHOT: "SESSION_SNAPSHOT",
    TIMELINE_EVENT: "TIMELINE_EVENT",
    GET_VIDEO_STATE: "GET_VIDEO_STATE",
    SEEK_TO: "SEEK_TO",
    ADD_BOOKMARK: "ADD_BOOKMARK",
    DELETE_BOOKMARK: "DELETE_BOOKMARK",
    OVERLAY_UPDATE: "OVERLAY_UPDATE",
    TAB_REMOVED: "TAB_REMOVED",
    TAB_UPDATED: "TAB_UPDATED"
  });

  const SESSION_STATE = Object.freeze({
    IDLE: "IDLE",
    STARTING: "STARTING",
    CAPTURING: "CAPTURING",
    PAUSED_BACKPRESSURE: "PAUSED_BACKPRESSURE",
    PAUSED_QUOTA: "PAUSED_QUOTA",
    STOPPING: "STOPPING",
    STOPPED: "STOPPED",
    ERROR: "ERROR"
  });

  root.LectureProtocol = Object.freeze({ TARGET, MESSAGE, SESSION_STATE });
})(globalThis);
