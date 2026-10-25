import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { readGrid } from "./table";

describe("readGrid", () => {
  it("reads xlsx cells and turns date cells into ISO text", () => {
    const ws = XLSX.utils.aoa_to_sheet([["program", "start", "n"], ["Art", new Date(Date.UTC(2025, 2, 10)), 25]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx", cellDates: true }));
    expect(readGrid("a.xlsx", bytes)).toEqual([["program", "start", "n"], ["Art", "2025-03-10", "25"]]);
  });
  it("reads csv with a BOM", () => {
    expect(readGrid("a.csv", new TextEncoder().encode("﻿a,b\n1,2\n"))).toEqual([["a", "b"], ["1", "2"]]);
  });
});
