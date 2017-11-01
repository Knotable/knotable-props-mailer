Meteor.methods
  createNewMailingList: (newName, newAlias)->
    throw new Meteor.Error 401, 'Unauthorized' unless Meteor.userId()
    return mailingListServer.createNewMailingList newName, newAlias

  updateMailingListProperties: (originalAlias, newName, newAlias) ->
    throw new Meteor.Error 401, 'Unauthorized' unless Meteor.userId()
    return mailingListServer.updateMailingListProperties originalAlias, newName, newAlias

  syncMailChimpToMailGun: (alias) ->
    throw new Meteor.Error 401, 'Unauthorized' unless Meteor.userId()
    return mailingListServer.syncMailChimpToMailGun alias

  syncMembersFromKnotableToMailGun: (alias) ->
    throw new Meteor.Error 401, 'Unauthorized' unless Meteor.userId()
    return mailingListServer.syncMembersFromKnotableToMailGun alias

  syncMailingListFromMailGun: () ->
    throw new Meteor.Error 401, 'Unauthorized' unless Meteor.userId()
    return mailingListServer.syncMailingListFromMailGun()
