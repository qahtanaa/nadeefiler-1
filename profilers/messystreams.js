var _ = require('lodash');

// types functions should test value and return boolean if it is instance of it
var booleanValues = [
  "true", "false",
  "t", "f",
  "yes", "no",
  "y", "n",
  "1", "0"
];

var numberRegex = /^[+-]?([\d]+)(\.?([\d]*))((e|E)([+-]?[\d]+))?$/;
var dateRegex = /^((((0[13578])|([13578])|(1[02]))[\/](([1-9])|([0-2][0-9])|(3[01])))|(((0[469])|([469])|(11))[\/](([1-9])|([0-2][0-9])|(30)))|((2|02)[\/](([1-9])|([0-2][0-9]))))[\/]\d{4}$|^\d{4}$/;
// TODO more comprehensive dateRegex or search for npm

var types = {
  'boolean': function(value) {
    if (_.indexOf(booleanValues, _.toLower(value)) > -1)
      return 'boolean';
  },
  'number': function(value){
    var m = value.match(numberRegex);
    // m[1]: whole part
    // m[2]: .decimal part
    // m[3]: decimal part
    // m[4]: eX
    // m[5]: e
    // m[6]: X
    // console.log(m)
    if (!m) return; // not a number
    // now decide if number is integer or float
    if (!m[6]) // no eX
      return m[3] ? 'float' : 'integer';
    // eX exists, check the distance it moves decimal point left (-) or right (+)
    return parseInt(m[6]) - m[3].length < 0 ? 'float' : 'integer';
  },
  'date': function(value) {
    if (value.match(dateRegex))
      return 'date';
  },
  'string': function(value) {
    return value != '' ? 'string' : 'null';
  }
};

var initialScores = {
  boolean: 0,
  integer: 0,
  float: 0,
  date: 0,
  string: 0,
  null: 0
};

var scores = {};
/* scores example: 
  {
    key1: {
      integer: score1,
      float: score2
    },
    key2: {
      float: score3,
      boolean: score4,
      string: score5
    },
    key3: {
      date: score6,
      string: score7
    }
  }
*/

module.exports = {
  selector: function(mongoCollection, dataset, keys) {
    // init scores
    _.forEach(keys, function(key){
      scores[key] = _.clone(initialScores);
    });

    // because this is an onValue profiler, return hash of streams for each key
    return _.reduce(keys, function(hash, key){
      var pipeline = [
        {$match: {"dataset": dataset}},
        {$group: {"_id": "$" + key, "count": {$sum: 1}}}
      ];
      return _.set(hash, key, mongoCollection.aggregate(pipeline));
    }, {});
  },
  onValue: function(key, value) {
    // detect datatypes score for value._id multiplied by value.
    _.forEach(types, function(detector, type){
      var result = detector(value._id);
      if (result) {
        // console.log(value._id, result);
        scores[key][result] += value.count;
        return false;
      }
    })
  },
  onFinish: function(key) {
    console.log(">>>> score for %s is", key, scores[key]);
    return scores[key];
  }
};