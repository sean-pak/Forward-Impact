// The 31 adult institutions on CDCR's Facility Locator (Adult Facilities):
// https://www.cdcr.ca.gov/facility-locator/ (checked 2026-10-24).
// Codes follow docs/schema-v2.md. Two differ from CDCR's own abbreviations:
// San Quentin is SQ here (CDCR: SQRC) and SATF is SATF here (CDCR: SATF-CSP).
// The CDCR forms are kept as aliases.
//
// Aliases are only towns or short names that point at ONE institution. Shared towns
// (Delano, Soledad, Chowchilla, Vacaville) and bare "Corcoran" are left out on purpose
// so they come back as unmatched and Sam asks, instead of guessing.

export type Facility = {
  facility_code: string;
  facility_name: string;
  aliases: string[];
};

export const FACILITIES: Facility[] = [
  { facility_code: "ASP", facility_name: "Avenal State Prison", aliases: ["Avenal"] },
  { facility_code: "CAL", facility_name: "Calipatria State Prison", aliases: ["Calipatria"] },
  { facility_code: "CCI", facility_name: "California Correctional Institution", aliases: ["Tehachapi"] },
  { facility_code: "CCWF", facility_name: "Central California Women's Facility", aliases: [] },
  { facility_code: "CEN", facility_name: "Centinela State Prison", aliases: ["Centinela"] },
  { facility_code: "CHCF", facility_name: "California Health Care Facility, Stockton", aliases: ["California Health Care Facility", "Stockton"] },
  { facility_code: "CIM", facility_name: "California Institution for Men", aliases: ["Chino"] },
  { facility_code: "CIW", facility_name: "California Institution for Women", aliases: ["Frontera"] },
  { facility_code: "CMC", facility_name: "California Men's Colony", aliases: ["Men's Colony", "San Luis Obispo"] },
  { facility_code: "CMF", facility_name: "California Medical Facility", aliases: [] },
  { facility_code: "COR", facility_name: "California State Prison, Corcoran", aliases: ["Corcoran State Prison", "CSP-Corcoran", "CSP Corcoran"] },
  { facility_code: "CRC", facility_name: "California Rehabilitation Center", aliases: ["Norco"] },
  { facility_code: "CTF", facility_name: "Correctional Training Facility", aliases: [] },
  { facility_code: "FSP", facility_name: "Folsom State Prison", aliases: ["Folsom", "Old Folsom"] },
  { facility_code: "HDSP", facility_name: "High Desert State Prison", aliases: ["High Desert", "Susanville"] },
  { facility_code: "ISP", facility_name: "Ironwood State Prison", aliases: ["Ironwood", "Blythe"] },
  { facility_code: "KVSP", facility_name: "Kern Valley State Prison", aliases: ["Kern Valley"] },
  { facility_code: "LAC", facility_name: "California State Prison, Los Angeles County", aliases: ["CSP-LAC", "CSP Los Angeles County", "Lancaster"] },
  { facility_code: "MCSP", facility_name: "Mule Creek State Prison", aliases: ["Mule Creek", "Ione"] },
  { facility_code: "NKSP", facility_name: "North Kern State Prison", aliases: ["North Kern"] },
  { facility_code: "PBSP", facility_name: "Pelican Bay State Prison", aliases: ["Pelican Bay", "Crescent City"] },
  { facility_code: "PVSP", facility_name: "Pleasant Valley State Prison", aliases: ["Pleasant Valley", "Coalinga"] },
  { facility_code: "RJD", facility_name: "R.J. Donovan Correctional Facility", aliases: ["Donovan", "Richard J. Donovan", "RJ Donovan"] },
  { facility_code: "SAC", facility_name: "California State Prison, Sacramento", aliases: ["CSP-Sacramento", "CSP Sacramento", "CSP-SAC", "New Folsom", "Represa"] },
  { facility_code: "SATF", facility_name: "Substance Abuse Treatment Facility and State Prison, Corcoran", aliases: ["SATF-CSP", "SATF Corcoran", "Substance Abuse Treatment Facility"] },
  { facility_code: "SCC", facility_name: "Sierra Conservation Center", aliases: ["Jamestown"] },
  { facility_code: "SOL", facility_name: "California State Prison, Solano", aliases: ["Solano", "CSP-Solano", "CSP Solano"] },
  { facility_code: "SQ", facility_name: "San Quentin Rehabilitation Center", aliases: ["San Quentin", "San Quentin State Prison", "SQSP", "SQRC", "S.Q.", "Quentin"] },
  { facility_code: "SVSP", facility_name: "Salinas Valley State Prison", aliases: ["Salinas Valley"] },
  { facility_code: "VSP", facility_name: "Valley State Prison", aliases: [] },
  { facility_code: "WSP", facility_name: "Wasco State Prison", aliases: ["Wasco"] },
];
