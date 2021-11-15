import { getDomains } from "../mailgunDomains"

Meteor.methods
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



  updateDraftEmail: (emailData) ->
    throw new Meteor.Error 401, 'Unauthorized' unless Meteor.userId()
    check emailData, Object
    { _id, from, subject, html, recipients, campaigns, tags } = emailData
    check _id, String
    check from, Match.Maybe String
    check subject, Match.Maybe String
    check html, Match.Maybe String
    check recipients, Match.Maybe [ String ]
    check campaigns, Match.Maybe [ String ]
    check tags, Match.Maybe [ String ]
    unless EmailEvents.find(_id: _id, type: EmailHelperShared.DRAFT).count()
      throw new Meteor.Error 403, 'Only draft email is allowed'
    emailData = { from, subject, html, recipients, campaigns, tags }
    Boolean EmailEvents.update _id, $set: emailData



  getDomains: ->
    throw new Meteor.Error 401, 'Unauthorized' unless Meteor.userId()
    return getDomains()
