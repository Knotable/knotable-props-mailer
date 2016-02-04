@AuthHelper =
  getLoginTokenForDomain: (domain, cb) ->
    console.log 'auth'
    token = Meteor.call 'getStampedToken'