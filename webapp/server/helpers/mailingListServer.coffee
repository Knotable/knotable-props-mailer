import MailgunClient from "../mailgunClient"

class @MailingListServer
  syncMailingListFromMailGun: () ->
    mailingListItems = Promise.await(MailgunClient.lists.list())
    if mailingListItems and mailingListItems.length > 0
      MailingList.remove({})
      _.each mailingListItems, (m) ->
        mailingListShared.createAMailingListIfNotExisting(m.name, m.address, m.description, m.access_level)



  updateMailingListProperties: (originalAlias, newName, newAlias) ->
    try
      resultData = Promise.await(
        MailgunClient.lists.update(originalAlias, {
          address: newAlias
          name: newName
        })
      )
      mailingListShared.updateMailingListProperties originalAlias, newName, newAlias
      console.log "[updateMailingListProperties]:", resultData
      return "Mailing list[name='#{newName}', alias='#{newAlias}'] has been updated"
    catch error
      console.error error if error
      console.log error.stack if error.stack
      errorMessage =
        status: STATUS_ERROR
        message: error
      return errorMessage

  createNewMailingList: (newName, newAlias) ->
    try
      currentDate = new Date()
      description = "created at #{currentDate.toString()}"

      resultData = Promise.await(
        MailgunClient.lists.create({
          address: newAlias
          name: newName
          access_level: "readonly"
          description: description
        })
      )

      mailingListShared.createAMailingListIfNotExisting(newName, newAlias, description)
      console.log "[createNewMailingList]:", resultData
      return "Created a new mailing list[name='#{newName}', alias='#{newAlias}']"
    catch error
      console.error error
      console.log error.stack if error.stack
      errorMessage =
        status: STATUS_ERROR
        message: error
      return errorMessage



  updateMailingListDescription: (alias, name) ->
    try
      mailingList = MailingList.findOne alias: alias, name: name
      return unless mailingList
      currentDate = new Date()
      description = "as if #{currentDate.toString()}"
      resultData = Promise.await(
        MailgunClient.lists.update(alias, {
          address: alias
          name: name
          description: description
        })
      )
      mailingListShared.createAMailingListIfNotExisting(name, alias, description)
      console.log "[updateMailingListDescription]:", resultData
    catch error
      console.error error if error
      console.log error.stack if error.stack
      errorMessage =
        status: STATUS_ERROR
        message: error
      return errorMessage



  addMembersToMailingList: (alias, members) ->
    try
      noOfMembers = members.length
      unless members || members.length
        errorMessage =
          status: STATUS_ERROR
          message: "[addMembersToMailingList] Error: Member list is empty. Please have a check."
        return errorMessage

      mailingList = MailingList.findOne alias: alias
      unless mailingList
        errorMessage =
          status: STATUS_ERROR
          message: "[addMembersToMailingList] Error: Could not found the mailingList #{alias}"
        return errorMessage

      noOfMembers = members.length
      startIndex = 0
      batchSize = 999
      while noOfMembers > 0
        endIndex = startIndex + batchSize
        membersInABatch = members.slice(startIndex, endIndex)
        startIndex = endIndex
        noOfMembers = noOfMembers - batchSize
        Promise.await(
          MailgunClient.lists.members.createMembers(alias, {
            "members": JSON.stringify(membersInABatch)
            "upsert": false
          })
        )
      return "Added members to mailingList[alias='#{alias}'] successfully"
    catch error
      console.error error
      console.log error.stack if error.stack
      errorMessage =
        status: STATUS_ERROR
        message: error
      return errorMessage



  syncMembersFromKnotableToMailGun: (alias)->
    try
      mailingList = MailingList.findOne alias: alias
      unless mailingList
        return "[syncMembersFromKnotableToMailGun] Error: Could not find mailingList #{alias}"

      knotableUrl = Meteor.settings.beta_knotable.user_export_url + '/' + ApiAuthHelper.getAuthToken()
      resultData = _getFromKnotable(knotableUrl)
      if resultData.status is STATUS_ERROR
        console.log resultData.message
        return resultData.message

      if resultData?.data?
        members = mailingListShared.buildMembersFromKnotable(resultData.data)
        unless _.isEmpty members
          @addMembersToMailingList(alias, members)
        @updateMailingListDescription(alias, mailingList.name)
        return "Synced mailing list from Knotable to MailGun successfully"
    catch error
      console.error error if error
      console.log error.stack if error.stack
      errorMessage =
        status: STATUS_ERROR
        message: error
      return errorMessage



  syncMailChimpToMailGun: (alias)->
    try
      mailingList = MailingList.findOne alias: alias
      unless mailingList
        return "[syncMailChimpToMailGun] Error: Could not found the mailingList #{alias}"

      mailChimApiKey = Meteor.settings.mailChimp.api_key
      mailChimBaseUrl = Meteor.settings.mailChimp.base_url
      mailListId = Meteor.settings.mailChimp.default_list_id
      mailChimpUrl = "#{mailChimBaseUrl}/?method=listMembers&apikey=#{mailChimApiKey}&id=#{mailListId}&limit=15000&output=json"

      resultData = _getFromMailChimp(mailChimpUrl)
      if resultData.status is STATUS_ERROR
        console.log resultData.message
        return resultData.message

      if resultData?.data?.data?
        members = mailingListShared.buildMembersFromMailChimpData(resultData.data.data)
        unless _.isEmpty members
          @addMembersToMailingList(alias, members)
        @updateMailingListDescription(alias, mailingList.name)
        return "Synced mailing list from MailChimp to MailGun successfully"
    catch error
      console.error error if error
      console.log error.stack if error.stack
      errorMessage =
        status: STATUS_ERROR
        message: error
      return errorMessage



  _getFromKnotable = (getURL, params = {}) ->
    console.log "[_getFromKnotable] KnotableApiUrl: #{getURL}, params: ", params
    return HTTP.get getURL, params



  _getFromMailChimp = (getURL, params = {}) ->
    console.log "[_getFromMailChimp] MailChimpApiUrl: #{getURL}, params: ", params
    return HTTP.get getURL, params



@mailingListServer = new MailingListServer()
