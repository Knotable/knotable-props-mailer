@Files = new Meteor.Collection("files")


Files.validation =
  requiredFields: [
    's3_url'
    'type'
  ]
  uniqueFields: [
    's3_url'
  ]



@Files.deny
  insert: (userId, doc) ->
    true

  update: (userId, doc, fieldNames, modifier) ->
    true

  remove: (userId, doc) ->
    true


if Meteor.isServer 
  Files.createIndex({
    s3_url: 1
  })
