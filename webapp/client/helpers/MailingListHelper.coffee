@MailingListHelper =
  getDomainFromAlias: (alias) ->
    if alias
      return alias.substring alias.indexOf('@')
    return ""



  getAliasWithoutDomain: (alias) ->
    if alias
      return alias.substring 0, alias.indexOf('@')
    return ""


  updateProperties: ($mailingList, section) ->
    mailingListId = $mailingList.attr("data-id")
    name = $mailingList.find('.mailing-list-name').val()
    aliasWithoutDomain = $mailingList.find('.mailing-list-alias').val()

    unless ValidationsHelper.isValidMailingListName(name)
      showErrorBootstrapGrowl "Invalid name with '#{mailingListId}'."
      return

    alias = aliasWithoutDomain + MAILGUN_KNOTABLE_DOMAIN
    unless ValidationsHelper.isCorrectEmail(alias)
      showErrorBootstrapGrowl "Invalid alias with '#{alias}'."
      return

    mailingList = MailingList.findOne $or:[{name: name}, {alias: alias}]
    unless mailingList
      isOk = confirm "No mailing list with [name='#{name}', alias='#{alias}'] found. Do you create this one?"
      return unless isOk

    mailingListShared.updateOrCreateIfNotExisting(name, alias)
    if section is KNOTABLE_WEEKLY_UPDATE_NAME
      Session.set "KNOTABLE_UPDATE_ACTIVE_ALIAS", alias
    else
      Session.set "KNOTE_BLOG_LIST_ALIAS", alias



  getCurrentAlias: ($mailingList) ->
    mailingListId = $mailingList.attr("data-id")
    name = $mailingList.find('.mailing-list-name').val()
    aliasWithoutDomain = $mailingList.find('.mailing-list-alias').val()
    alias = aliasWithoutDomain + MAILGUN_KNOTABLE_DOMAIN
    unless ValidationsHelper.isCorrectEmail(alias)
      showErrorBootstrapGrowl "Invalid alias with '#{alias}'."
      return
    return alias



