type AgeRatingMapEntry = {
  system: string;
  name: string;
  minAge: number;
  /** Matched case-insensitively against rating_category.rating from the IGDB API */
  ratingName: string;
};

export const GameVaultIgdbAgeRatingMap: AgeRatingMapEntry[] = [
  { system: "PEGI", name: "Three", minAge: 3, ratingName: "Three" },
  { system: "PEGI", name: "Seven", minAge: 7, ratingName: "Seven" },
  { system: "PEGI", name: "Twelve", minAge: 12, ratingName: "Twelve" },
  { system: "PEGI", name: "Sixteen", minAge: 16, ratingName: "Sixteen" },
  { system: "PEGI", name: "Eighteen", minAge: 18, ratingName: "Eighteen" },
  { system: "ESRB", name: "EC", minAge: 3, ratingName: "EC" },
  { system: "ESRB", name: "E", minAge: 6, ratingName: "E" },
  { system: "ESRB", name: "E10", minAge: 10, ratingName: "E10" },
  { system: "ESRB", name: "T", minAge: 13, ratingName: "T" },
  { system: "ESRB", name: "M", minAge: 17, ratingName: "M" },
  { system: "ESRB", name: "AO", minAge: 18, ratingName: "AO" },
  { system: "CERO", name: "CERO_A", minAge: 0, ratingName: "CERO_A" },
  { system: "CERO", name: "CERO_B", minAge: 12, ratingName: "CERO_B" },
  { system: "CERO", name: "CERO_C", minAge: 15, ratingName: "CERO_C" },
  { system: "CERO", name: "CERO_D", minAge: 17, ratingName: "CERO_D" },
  { system: "CERO", name: "CERO_Z", minAge: 18, ratingName: "CERO_Z" },
  { system: "USK", name: "USK_0", minAge: 0, ratingName: "USK_0" },
  { system: "USK", name: "USK_6", minAge: 6, ratingName: "USK_6" },
  { system: "USK", name: "USK_12", minAge: 12, ratingName: "USK_12" },
  { system: "USK", name: "USK_16", minAge: 16, ratingName: "USK_16" },
  { system: "USK", name: "USK_18", minAge: 18, ratingName: "USK_18" },
  { system: "GRAC", name: "GRAC_ALL", minAge: 0, ratingName: "GRAC_ALL" },
  {
    system: "GRAC",
    name: "GRAC_Twelve",
    minAge: 12,
    ratingName: "GRAC_Twelve",
  },
  {
    system: "GRAC",
    name: "GRAC_Fifteen",
    minAge: 15,
    ratingName: "GRAC_Fifteen",
  },
  {
    system: "GRAC",
    name: "GRAC_Eighteen",
    minAge: 18,
    ratingName: "GRAC_Eighteen",
  },
  {
    system: "CLASS_IND",
    name: "CLASS_IND_L",
    minAge: 0,
    ratingName: "CLASS_IND_L",
  },
  {
    system: "CLASS_IND",
    name: "CLASS_IND_Ten",
    minAge: 10,
    ratingName: "CLASS_IND_Ten",
  },
  {
    system: "CLASS_IND",
    name: "CLASS_IND_Twelve",
    minAge: 12,
    ratingName: "CLASS_IND_Twelve",
  },
  {
    system: "CLASS_IND",
    name: "CLASS_IND_Fourteen",
    minAge: 14,
    ratingName: "CLASS_IND_Fourteen",
  },
  {
    system: "CLASS_IND",
    name: "CLASS_IND_Sixteen",
    minAge: 16,
    ratingName: "CLASS_IND_Sixteen",
  },
  {
    system: "CLASS_IND",
    name: "CLASS_IND_Eighteen",
    minAge: 18,
    ratingName: "CLASS_IND_Eighteen",
  },
  { system: "ACB", name: "ACB_G", minAge: 0, ratingName: "ACB_G" },
  { system: "ACB", name: "ACB_PG", minAge: 8, ratingName: "ACB_PG" },
  { system: "ACB", name: "ACB_M", minAge: 15, ratingName: "ACB_M" },
  { system: "ACB", name: "ACB_MA15", minAge: 15, ratingName: "ACB_MA15" },
  { system: "ACB", name: "ACB_R18", minAge: 18, ratingName: "ACB_R18" },
];
