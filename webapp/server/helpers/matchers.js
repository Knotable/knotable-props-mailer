import { check, Match } from "meteor/check";

const documentIdLength = 17;

export function notEmptyStringMatcher() {
  return Match.Where((v) => {
    check(v, String);
    return v.length > 0;
  });
}

export function notEmptyDocumentIdMatcher() {
  return Match.Where((v) => {
    check(v, String);
    return v.length === documentIdLength;
  });
}
