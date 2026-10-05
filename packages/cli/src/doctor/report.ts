export type Level = "OK" | "INFO" | "WARN" | "FAIL";

/** Where a check writes what it found. */
export type Report = (level: Level, message: string) => void;
