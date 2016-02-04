Template.mailing_list_container.helpers
  knotableWeeklyUpdate : ->
    if Session.get "KNOTABLE_UPDATE_ACTIVE_ALIAS"
      return MailingList.findOne alias: Session.get "KNOTABLE_UPDATE_ACTIVE_ALIAS"
    else
      return MailingList.findOne alias: KNOTABLE_WEEKLY_UPDATE_NAME

  knoteBlogList : ->
    if Session.get "KNOTE_BLOG_LIST_ALIAS"
      return MailingList.findOne alias: Session.get "KNOTE_BLOG_LIST_ALIAS"
    else
      return MailingList.findOne alias: KNOTE_COM_NAME



Template.knotable_active_users.helpers
  aliasWithoutDomain : ->
    MailingListHelper.getAliasWithoutDomain(@alias)

  domain : ->
    MAILGUN_KNOTABLE_DOMAIN

Template.knotable_active_users.events
  'click .btn-update': (e) ->
    $mailingList = $(e.currentTarget).closest(".mailgun-mailing-list")
    alias = MailingListHelper.getCurrentAlias($mailingList)
    if alias
      mailingListShared.updateKnoteWeeklyActive(alias)

  'click .btn-change-properties': (e) ->
    $mailingList = $(e.currentTarget).closest(".mailgun-mailing-list")
    MailingListHelper.updateProperties($mailingList, KNOTABLE_WEEKLY_UPDATE_NAME)



Template.knote_mailing_list.helpers
  aliasWithoutDomain : ->
    MailingListHelper.getAliasWithoutDomain(@alias)

  domain : ->
    MailingListHelper.getDomainFromAlias(@alias)



Template.knote_mailing_list.events
  'click .btn-update': (e) ->
    $mailingList = $(e.currentTarget).closest(".mailgun-mailing-list")
    alias = MailingListHelper.getCurrentAlias($mailingList)
    if alias
      mailingListShared.updateKnoteBlogList(alias)



  'click .btn-change-properties': (e) ->
    $mailingList = $(e.currentTarget).closest(".mailgun-mailing-list")
    MailingListHelper.updateProperties($mailingList, KNOTE_COM_NAME)