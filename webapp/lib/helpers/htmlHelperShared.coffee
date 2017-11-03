@HtmlHelperShared =
  htmlToText: (htmlString) ->
    return '' unless htmlString
    check htmlString, String
    wrappedHtml = "<div>#{htmlString}</div>"
    if Meteor.isClient
      jQuery(wrappedHtml).text()
    else
      cheerio = require 'cheerio'
      cheerio.load(wrappedHtml).root().text()



  htmlToTruncatedText: (htmlString, textLength = 20) ->
    check textLength, Number
    text = HtmlHelperShared.htmlToText htmlString
    text.substr 0, textLength



  hasHtmlText: (htmlString) ->
    Boolean HtmlHelperShared.htmlToText(htmlString).trim()
