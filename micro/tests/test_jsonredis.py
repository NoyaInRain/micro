# jsonredis
# Released into the public domain
# https://github.com/noyainrain/micro/blob/master/micro/jsonredis.py

# pylint: disable=missing-docstring; test module

from collections import OrderedDict
from itertools import count
import json
from unittest import TestCase
from unittest.mock import Mock

from redis import StrictRedis
from redis.exceptions import ResponseError
from micro.jsonredis import (JSONRedis, RedisList, RedisSortedSet, JSONRedisSequence,
                             JSONRedisMapping)

class JSONRedisTestCase(TestCase):
    def setUp(self):
        self.r = JSONRedis(StrictRedis(db=15), encode=Cat.encode, decode=Cat.decode)
        self.r.flushdb()

class JSONRedisTest(JSONRedisTestCase):
    def setup_data(self, cache=True):
        cat = Cat('cat:0', 'Happy')
        if cache:
            self.r.oset(cat.id, cat)
        else:
            self.r.set(cat.id, json.dumps(Cat.encode(cat)))
        return cat

    def test_oset_oget(self):
        cat = self.setup_data()
        got_cat = self.r.oget('cat:0')
        self.assertIsInstance(got_cat, Cat)
        self.assertEqual(got_cat, cat)
        self.assertEqual(got_cat.instance_id, cat.instance_id)

    def test_oset_oget_caching_disabled(self):
        self.r.caching = False

        cat = self.setup_data()
        got_cat = self.r.oget('cat:0')
        self.assertIsInstance(got_cat, Cat)
        self.assertEqual(got_cat, cat)
        self.assertNotEqual(got_cat.instance_id, cat.instance_id)

    def test_oget_object_destroyed(self):
        cat = self.setup_data()
        destroyed_instance_id = cat.instance_id
        del cat
        got_cat = self.r.oget('cat:0')
        self.assertNotEqual(got_cat.instance_id, destroyed_instance_id)

    def test_oget_cache_empty(self):
        self.setup_data(cache=False)

        got_cat = self.r.oget('cat:0')
        same_cat = self.r.oget('cat:0')
        self.assertEqual(same_cat, got_cat)
        self.assertEqual(same_cat.instance_id, got_cat.instance_id)

    def test_oget_cache_empty_caching_disabled(self):
        self.setup_data(cache=False)
        self.r.caching = False

        got_cat = self.r.oget('cat:0')
        same_cat = self.r.oget('cat:0')
        self.assertEqual(same_cat, got_cat)
        self.assertNotEqual(same_cat.instance_id, got_cat.instance_id)

    def test_oget_key_nonexistant(self):
        self.assertIsNone(self.r.oget('foo'))

    def test_oget_value_not_json(self):
        self.r.set('not-json', 'not-json')
        with self.assertRaises(ResponseError):
            self.r.oget('not-json')

    def test_oget_default(self):
        cat = self.setup_data()
        self.assertEqual(self.r.oget(cat.id, default=Cat('cat', 'Default')), cat)

    def test_oget_default_missing_key(self):
        cat = Cat('cat', 'Default')
        self.assertEqual(self.r.oget('foo', default=cat), cat)

    def test_oget_default_exception_missing_key(self):
        with self.assertRaises(KeyError):
            self.r.oget('foo', default=KeyError)

    def test_omget_omset(self):
        cats = {'cat:0': Cat('cat:0', 'Happy'), 'cat:1': Cat('cat:1', 'Grumpy')}
        self.r.omset(cats)
        got_cats = self.r.omget(cats.keys())
        self.assertEqual(got_cats, list(cats.values()))

class RedisSequenceTest:
    def make_seq(self):
        items = [b'a', b'b', b'c', b'd']
        seq = self.do_make_seq(items)
        return seq, items

    def do_make_seq(self, items):
        raise NotImplementedError()

    def test_index(self):
        seq, items = self.make_seq()
        self.assertEqual(seq.index(b'c'), items.index(b'c'))

    def test_index_missing_x(self):
        seq, _ = self.make_seq()
        with self.assertRaises(ValueError):
            seq.index(b'foo')

    def test_len(self):
        seq, items = self.make_seq()
        self.assertEqual(len(seq), len(items))

    def test_getitem(self):
        seq, items = self.make_seq()
        self.assertEqual(seq[1], items[1])

    def test_getitem_key_negative(self):
        seq, items = self.make_seq()
        self.assertEqual(seq[-2], items[-2])

    def test_getitem_key_out_of_range(self):
        seq, _ = self.make_seq()
        with self.assertRaises(IndexError):
            # pylint: disable=pointless-statement; error is triggered on access
            seq[42]

    def test_getitem_key_slice(self):
        seq, items = self.make_seq()
        self.assertEqual(seq[1:3], items[1:3])

    def test_getitem_key_no_start(self):
        seq, items = self.make_seq()
        self.assertEqual(seq[:3], items[:3])

    def test_getitem_key_no_stop(self):
        seq, items = self.make_seq()
        self.assertEqual(seq[1:], items[1:])

    def test_getitem_key_stop_zero(self):
        seq, _ = self.make_seq()
        self.assertFalse(seq[0:0])

    def test_getitem_key_stop_lt_start(self):
        seq, _ = self.make_seq()
        self.assertFalse(seq[3:1])

    def test_getitem_key_stop_negative(self):
        seq, items = self.make_seq()
        self.assertEqual(seq[1:-1], items[1:-1])

    def test_getitem_key_stop_out_of_range(self):
        seq, items = self.make_seq()
        self.assertEqual(seq[0:42], items)

    def test_iter(self):
        seq, items = self.make_seq()
        self.assertEqual(list(iter(seq)), items)

    def test_contains(self):
        seq, _ = self.make_seq()
        self.assertTrue(b'b' in seq)

    def test_contains_missing_item(self):
        seq, _ = self.make_seq()
        self.assertFalse(b'foo' in seq)

class RedisListTest(JSONRedisTestCase, RedisSequenceTest):
    def do_make_seq(self, items):
        self.r.rpush('seq', *items)
        return RedisList('seq', self.r.r)

class RedisSortedSetTest(JSONRedisTestCase, RedisSequenceTest):
    def do_make_seq(self, items):
        self.r.zadd('seq', {item: i for i, item in enumerate(items)})
        return RedisSortedSet('seq', self.r.r)

class JSONRedisSequenceTest(JSONRedisTestCase):
    def setUp(self):
        super().setUp()
        self.list = [Cat('Cat:0', 'Happy'), Cat('Cat:1', 'Grumpy'), Cat('Cat:2', 'Long'),
                     Cat('Cat:3', 'Monorail')]
        self.r.omset({c.id: c for c in self.list})
        self.r.rpush('cats', *(c.id for c in self.list))
        self.cats = JSONRedisSequence(self.r, 'cats')

    def test_getitem(self):
        self.assertEqual(self.cats[1], self.list[1])

    def test_getitem_key_slice(self):
        self.assertEqual(self.cats[1:3], self.list[1:3])

    def test_getitem_pre(self):
        pre = Mock()
        cats = JSONRedisSequence(self.r, 'cats', pre=pre)
        self.assertTrue(cats[0])
        pre.assert_called_once_with()

    def test_len(self):
        self.assertEqual(len(self.cats), len(self.list))

class JSONRedisMappingTest(JSONRedisTestCase):
    def setUp(self):
        super().setUp()
        self.objects = OrderedDict([
            ('cat:0', Cat('cat:0', 'Happy')),
            ('cat:1', Cat('cat:1', 'Grumpy')),
            ('cat:2', Cat('cat:2', 'Long')),
            ('cat:3', Cat('cat:3', 'Monorail')),
            ('cat:4', Cat('cat:4', 'Ceiling'))
        ])
        self.r.omset(self.objects)
        self.r.rpush('cats', *self.objects.keys())
        self.cats = JSONRedisMapping(self.r, 'cats')

    def test_getitem(self):
        self.assertEqual(self.cats['cat:0'], self.objects['cat:0'])

    def test_iter(self):
        # Use list to also compare order
        self.assertEqual(list(iter(self.cats)), list(iter(self.objects)))

    def test_len(self):
        self.assertEqual(len(self.cats), len(self.objects))

    def test_contains(self):
        self.assertTrue('cat:0' in self.cats)
        self.assertFalse('foo' in self.cats)

class Cat:
    # We use an instance id generator instead of id() because "two objects with non-overlapping
    # lifetimes may have the same id() value"
    instance_ids = count()

    def __init__(self, id, name):
        self.id = id
        self.name = name
        self.instance_id = next(self.instance_ids)

    def __eq__(self, other):
        return self.id == other.id and self.name == other.name

    @staticmethod
    def encode(object):
        return {'id': object.id, 'name': object.name}

    @staticmethod
    def decode(json):
        # pylint: disable=redefined-outer-name; good name
        return Cat(**json)
