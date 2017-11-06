@MatchHelpers =
  nonEmptyString: Match.Where (x) ->
    check x, String
    x.length > 0



  nonEmptyHtmlString: Match.Where (x) ->
    check x, String
    x.length and HtmlHelperShared.hasHtmlTextOrImages x
