Meteor.methods
  findAndCreateIfNotExistingDraftEmail: ->
    return emailHelperShared.findAndCreateIfNotExistingDraftEmail()


  createEmailEvent: (from, subject, recipients, campaigns, file_ids, due_date, user_id, type = @DRAFT) ->
    emailHelperShared.createEmailEvent(from, subject, recipients, campaigns, file_ids, due_date, user_id, type)


  removeEmailEvent: (email_event_id) ->
    emailHelperShared.removeEmailEvent(email_event_id)


  updateEmailEvent: (emailData, type = EmailHelperShared.DRAFT, status = EmailHelperShared.IN_QUEUE) ->
    emailHelperShared.updateEmailEvent(emailData, type, status)


  sendEmailByEmailEventId: (email_event_id) ->
    emailServerShared.sendEmailByEmailEventId email_event_id


  getFileFromS3Url: (url) ->
    emailServerShared.getFileFromS3Url url


  sendTestEmail: (emailData) ->
    emailServerShared.sendEmailWithCampaign emailData
