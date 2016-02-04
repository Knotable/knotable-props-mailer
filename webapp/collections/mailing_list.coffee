# Store mailing list info from Mailgun
#Fields:
#  _id
#  unique_name
#  alias
#  name
#  description
#  list_id
#  date_created

@MailingList= new Meteor.Collection 'mailling_list'



@MailingList.allow
  insert: (userId, doc) ->
    true

  update: (userId, doc, fieldNames, modifier) ->
    true

  remove: (userId, doc) ->
    true