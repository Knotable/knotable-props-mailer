@MatchHelpers =
  nonEmptyString: Match.Where (x) ->
    check x, String
    x.length > 0
