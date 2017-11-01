_.mixin
  compactObject : (o) ->
    clone = _.clone o
    _.each clone, (v, k) -> delete clone[k] unless v
    clone
