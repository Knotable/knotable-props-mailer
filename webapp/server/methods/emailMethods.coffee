Meteor.methods
  findAndCreateIfNotExistingDraftEmail: ->
    throw new Meteor.Error 401, 'Unauthorized' unless Meteor.userId()
    return emailHelperShared.findAndCreateIfNotExistingDraftEmail()


  createEmailEvent: (from, subject, recipients, campaigns, file_ids, due_date, user_id, type = @DRAFT) ->
    throw new Meteor.Error 401, 'Unauthorized' unless Meteor.userId()
    emailHelperShared.createEmailEvent(from, subject, recipients, campaigns, file_ids, due_date, user_id, type)


  removeEmailEvent: (email_event_id) ->
    throw new Meteor.Error 401, 'Unauthorized' unless Meteor.userId()
    emailHelperShared.removeEmailEvent(email_event_id)


  updateEmailEvent: (emailData, type = EmailHelperShared.DRAFT, status = EmailHelperShared.IN_QUEUE) ->
    throw new Meteor.Error 401, 'Unauthorized' unless Meteor.userId()
    emailData = _.compactObject emailData
    check emailData, Match.ObjectIncluding
      _id: String
      from: String
      subject: MatchHelpers.nonEmptyString
      recipients: [ String ]
      html: MatchHelpers.nonEmptyHtmlString
      due_date: Date
      campaigns: Match.Optional [ String ]
      tags: Match.Optional [ String ]
    emailData.text = HtmlHelperShared.htmlToText emailData.html
    emailData.user_id = Meteor.userId()
    emailData.is_test = false
    emailHelperShared.updateEmailEvent(emailData, type, status)


  getFileFromS3Url: (url) ->
    throw new Meteor.Error 401, 'Unauthorized' unless Meteor.userId()
    emailServerShared.getFileFromS3Url url


  sendTestEmail: (emailData) ->
    throw new Meteor.Error 401, 'Unauthorized' unless Meteor.userId()
    emailData = _.compactObject emailData
    check emailData, Match.ObjectIncluding
      _id: String
      from: String
      subject: MatchHelpers.nonEmptyString
      html: MatchHelpers.nonEmptyHtmlString
      due_date: Date
      recipients: Match.Optional [ String ]
      campaigns: Match.Optional [ String ]
      tags: Match.Optional [ String ]
    emailData.text = HtmlHelperShared.htmlToText emailData.html
    emailData.user_id = Meteor.userId()
    emailData.is_test = true
    emailHelperShared.updateEmailEvent emailData
    emailServerShared.sendTestEmail emailData
