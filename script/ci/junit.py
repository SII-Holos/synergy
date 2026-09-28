import base64
import json
import sys
import xml.etree.ElementTree as ET


def tag(element):
    return element.tag.rsplit("}", 1)[-1]


def parse(report):
    result = {"index": report["index"], "cases": []}
    try:
        root = ET.fromstring(base64.b64decode(report["xml"], validate=True))
        if tag(root) not in {"testsuites", "testsuite"}:
            raise ValueError("Expected a JUnit testsuite or testsuites root")
        for element in root.iter():
            if tag(element) != "testcase":
                continue
            name = element.get("name")
            if not name:
                raise ValueError("JUnit testcase has no name")
            children = {tag(child) for child in element}
            status = element.get("status", "").lower()
            outcome = "passed"
            if "error" in children or status == "error":
                outcome = "error"
            elif "failure" in children or status in {"failed", "failure"}:
                outcome = "failure"
            elif "skipped" in children or status in {"skipped", "notrun", "disabled"}:
                outcome = "skipped"
            result["cases"].append({"name": name, "outcome": outcome})
    except (ET.ParseError, ValueError) as error:
        result["error"] = str(error)
    return result


json.dump([parse(report) for report in json.load(sys.stdin)], sys.stdout)
