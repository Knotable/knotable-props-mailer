class @MailingListServer
  Future = require 'fibers/future'

  MAILGUN_MAILING_LIST_URL_API = "https://api.mailgun.net/v3/lists"



  syncMailingListFromMailGun: () ->
    try
      params = {}
      getURL = MAILGUN_MAILING_LIST_URL_API
      resultData = _getFromMailgun getURL, params
      if resultData.status is STATUS_ERROR
        console.log resultData.message
        return resultData.message

      if resultData.data?.items?
        #Remove old mailing list in db
        MailingList.remove({})
        mailingListItems = resultData.data.items
        _.each mailingListItems, (m) ->
          console.log m
          mailingListShared.createAMailingListIfNotExisting(m.name, m.address, m.description, m.access_level)
    catch error
      console.error error if error
      console.log error.stack if error.stack
      errorMessage =
        status: STATUS_ERROR
        message: error
      return errorMessage


  updateMailingListProperties: (originalAlias, newName, newAlias) ->
    try
      putURL = MAILGUN_MAILING_LIST_URL_API + "/#{originalAlias}"
      params =
        params:
          address: newAlias
          name: newName
      resultData = _putToMailgun(putURL, params)
      if resultData.status is STATUS_ERROR
        console.log resultData.message
        return resultData.message

      #Update Data Change to DB
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
      postURL = MAILGUN_MAILING_LIST_URL_API
      params =
        params:
          address: newAlias
          name: newName
          access_level: "readonly"
          description: description

      resultData = _postToMailgun(postURL, params)
      if resultData.status is STATUS_ERROR
        console.log resultData.message
        return resultData

      #Create a mailing list in DB
      mailingListShared.createAMailingListIfNotExisting(newName, newAlias, description)
      console.log "[createNewMailingList]:", resultData
      return "Created a new mailing list[name='#{newName}', alias='#{newAlias}']"
    catch error
      console.error error if error
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
      putURL = MAILGUN_MAILING_LIST_URL_API + "/#{alias}"
      params =
        params:
          address: alias
          name: name
          description: description
      resultData = _putToMailgun(putURL, params)
      if resultData.status is STATUS_ERROR
        console.log resultData.message
        return resultData.message

      #Update Data Change to DB
      mailingListShared.createAMailingListIfNotExisting(name, alias, description)
      console.log "[updateMailingListDescription]:", resultData
    catch error
      console.error error if error
      console.log error.stack if error.stack
      errorMessage =
        status: STATUS_ERROR
        message: error
      return errorMessage



  #Only post less than 1000 members into mailing list of mailGun
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

      postURL = MAILGUN_MAILING_LIST_URL_API + "/#{alias}/members.json"
      noOfMembers = members.length

      startIndex = 0
      batchSize = 999
      while noOfMembers > 0
        endIndex = startIndex + batchSize
        membersInABatch = members.slice(startIndex, endIndex)
        startIndex = endIndex
        noOfMembers = noOfMembers - batchSize
        params =
          params:
            "members": JSON.stringify(membersInABatch)
            "upsert": false
        resultData = _postToMailgun(postURL, params)
        if resultData.status is STATUS_ERROR
          console.log resultData.message
          return resultData
      return "Added members to mailingList[alias='#{alias}'] successfully"
    catch error
      console.error error if error
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
          resultStatus = @addMembersToMailingList(alias, members)
          if resultStatus?.status? and resultStatus.status is STATUS_ERROR
            console.log resultStatus.message
            return resultStatus
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
          resultStatus = @addMembersToMailingList(alias, members)
        if resultStatus?.status? and resultStatus.status is STATUS_ERROR
          console.log resultStatus.message
          return resultStatus
        @updateMailingListDescription(alias, mailingList.name)
        return "Synced mailing list from MailChimp to MailGun successfully"
    catch error
      console.error error if error
      console.log error.stack if error.stack
      errorMessage =
        status: STATUS_ERROR
        message: error
      return errorMessage


  _postToMailgun = (putURL, params = {}) ->
    console.log "[_postToMailgun] MailgunApiUrl: #{putURL}, params: ", params
    waitingGetResult = new Future()
    returnData = null

    #Mailgun API KEY
    params.auth = 'api:' + Meteor.settings.mailgun.api_key

    HTTP.post putURL, params, (error, result) ->
      if error
        returnData =
          status : STATUS_ERROR
          message: '[_postToMailgun] Error: ' + error
      else
        returnData =
          status : STATUS_SUCCESS
          data: result?.data
      waitingGetResult.return()
    waitingGetResult.wait()
    return returnData


  _getFromMailgun = (getURL, params = {}) ->
    console.log "[_getFromMailgun] MailgunApiUrl: #{getURL}, params: ", params
    waitingGetResult = new Future()
    returnData = null

    #Mailgun API KEY
    params.auth = 'api:' + Meteor.settings.mailgun.api_key

    HTTP.get getURL, params, (error, result) ->
      if error
        returnData =
          status : STATUS_ERROR
          message: '[_getFromMailgun] Error: ' + error
      else
        returnData =
          status : STATUS_SUCCESS
          data: result?.data
      waitingGetResult.return()
    waitingGetResult.wait()
    return returnData

  _getFromKnotable = (getURL, params = {}) ->
    console.log "[_getFromKnotable] KnotableApiUrl: #{getURL}, params: ", params
    waitingGetResult = new Future()
    returnData = null

    HTTP.get getURL, params, (error, result) ->
      if error
        returnData =
          status : STATUS_ERROR
          message: '[_getFromKnotable] Error: ' + error
      else
        returnData =
          status : STATUS_SUCCESS
          data: result?.data
      waitingGetResult.return()
    waitingGetResult.wait()
    return returnData


  _getFromMailChimp = (getURL, params = {}) ->
    console.log "[_getFromMailChimp] MailChimpApiUrl: #{getURL}, params: ", params
    waitingGetResult = new Future()
    returnData = null

    HTTP.get getURL, params, (error, result) ->
      if error
        returnData =
          status : STATUS_ERROR
          message: '[_getFromMailChimp] Error: ' + error
      else
        returnData =
          status : STATUS_SUCCESS
          data: result?.data
      waitingGetResult.return()
    waitingGetResult.wait()
    return returnData


  _putToMailgun = (putURL, params = {}) ->
    console.log "[_putToMailgun] MailgunApiUrl: #{putURL}, params: ", params
    waitingGetResult = new Future()
    returnData = null

    #Mailgun API KEY
    params.auth = 'api:' + Meteor.settings.mailgun.api_key

    HTTP.put putURL, params, (error, result) ->
      if error
        returnData =
          status : STATUS_ERROR
          message: 'Error: ' + error
      else
        returnData =
          status : STATUS_SUCCESS
          data: result?.data
      waitingGetResult.return()
    waitingGetResult.wait()
    return returnData

@mailingListServer = new MailingListServer()
