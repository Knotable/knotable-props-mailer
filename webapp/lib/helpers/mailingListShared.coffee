class @MailingListShared
  self = @


  updateOrCreateIfNotExisting: (name, alias) ->
    mailingListByName = MailingList.findOne name: name
    mailingListByAlias = MailingList.findOne alias: alias
    if mailingListByName and mailingListByAlias and mailingListByName._id != mailingListByAlias._id
      if Meteor.isClient
        showBootstrapGrowl "Duplicated mailing list found.[name='#{mailingListByName.name}', alias='#{mailingListByName.alias}'] and [name='#{mailingListByAlias.name}', alias='#{mailingListByAlias.alias}']"
      return
    if mailingListByName
      Meteor.call "updateMailingListProperties", mailingListByName.alias, name, alias, (e, result) ->
        if e
          console.log "Error when creating new mailing list[name='#{name}', alias='#{alias}']", e
        else
          if result?.status? and result.status is STATUS_ERROR
            if Meteor.isClient
              showBootstrapGrowl "Error when creating new mailing list[name='#{name}', alias='#{alias}']. Error: #{result.message}"
          if _.isString result
            showBootstrapGrowl result
          return
      return
    if mailingListByAlias
      Meteor.call "updateMailingListProperties", mailingListByAlias.alias, name, alias, (e, result) ->
        if e
          console.log "Error when updating mailing list[name='#{name}', alias='#{alias}']", e
        else
          if result?.status? and result.status is STATUS_ERROR
            if Meteor.isClient
              showBootstrapGrowl "Error when updating new mailing list[name='#{name}', alias='#{alias}']. Error: #{result.message}"
          if _.isString result
            showBootstrapGrowl result
          return
      return

    unless mailingListByName or mailingListByAlias
      Meteor.call "createNewMailingList", name, alias, (e, result) ->
        if e
          console.log "Error when creating new mailing list[name='#{name}', alias='#{alias}']", e
        else
          if result?.status? and result.status is STATUS_ERROR
            if Meteor.isClient
              showBootstrapGrowl "Error when creating new mailing list[name='#{name}', alias='#{alias}']. Error: #{result.message}"
          if _.isString result
            showBootstrapGrowl result
          return
      return



  updateMailingListProperties: (originalAlias, name, alias, description = null, accessType = "readonly") ->
    mailingList = MailingList.findOne alias: originalAlias
    if mailingList
      mailingListData =
        name: name
        alias: alias
      if description
        mailingListData.description = description
      if accessType
        mailingListData.access_type = accessType
      MailingList.update {_id: mailingList._id}, {$set:  mailingListData}



  buildMembersFromMailChimpData: (data) ->
    return [] if _.isEmpty data
    members = []
    _.each data, (d) ->
      member =
        address : d.email
      members.push member
    return _.uniq members

  buildMembersFromKnotable: (data) ->
    return [] if _.isEmpty data
    members = []
    _.each data, (d) ->
      member =
        address : d.address
      members.push member
    return _.uniq members



  updateKnoteBlogList: (alias) ->
    showBootstrapGrowl("This action will take some minutes....")
    Meteor.call "syncMailChimpToMailGun", alias, (e, result) ->
      if Meteor.isClient
        Session.set "KNOTE_BLOG_LIST_ALIAS", alias
      if e
        console.log "Failed to syncMailChimpToMailGun", e
        if Meteor.isClient
          showBootstrapGrowl("Failed to Failed to syncMailChimpToMailGun")
      else
        if result?.status? and result.status is STATUS_ERROR
          if Meteor.isClient
            showBootstrapGrowl "Error: #{result.message}"
        if _.isString result
          showBootstrapGrowl result
        return



  updateKnoteWeeklyActive: (alias) ->
    showBootstrapGrowl("This action will take some minutes....")
    Meteor.call "syncMembersFromKnotableToMailGun", alias, (e, result) ->
      Session.set "KNOTABLE_UPDATE_ACTIVE_ALIAS", alias
      if e
        console.log "Failed to syncMembersFromKnotableToMailGun", e
        if Meteor.isClient
          showBootstrapGrowl("Failed to syncMembersFromKnotableToMailGun")
      else
        if result?.status? and result.status is STATUS_ERROR
          if Meteor.isClient
            showBootstrapGrowl "Error: #{result.message}"
        if _.isString result
          showBootstrapGrowl result
        Session.set
        return


  createAMailingListIfNotExisting: (name, alias, description, accessLevel = "readonly", listId = null) ->
    mailingListData =
      name: name
      alias: alias
      description: description
      access_level: accessLevel
    if listId
      mailingListData.list_id = listId
    mailingList = MailingList.findOne name: name, alias: alias
    if mailingList
      mailingListData.updated_time = new Date()
      MailingList.update {_id: mailingList._id}, {$set:  mailingListData}
      return mailingList._id
    else
      mailingListData.created_time = new Date()
      mailingListId = MailingList.insert mailingListData
      return mailingListId

@mailingListShared = new @MailingListShared()
