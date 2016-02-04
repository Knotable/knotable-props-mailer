Meteor.methods
  createNewMailingList: (newName, newAlias)->
    return mailingListServer.createNewMailingList newName, newAlias

  updateMailingListProperties: (originalAlias, newName, newAlias) ->
    return mailingListServer.updateMailingListProperties originalAlias, newName, newAlias

  syncMailChimpToMailGun: (alias) ->
    return mailingListServer.syncMailChimpToMailGun alias

  syncMembersFromKnotableToMailGun: (alias) ->
    return mailingListServer.syncMembersFromKnotableToMailGun alias

  syncMailingListFromMailGun: () ->
    return mailingListServer.syncMailingListFromMailGun()
