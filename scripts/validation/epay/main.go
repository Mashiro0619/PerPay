// SPDX-License-Identifier: MIT
package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"

	"github.com/Calcium-Ion/go-epay/epay"
)

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var input struct {
		Config       map[string]string `json:"config"`
		Request      map[string]string `json:"request"`
		Notification map[string]string `json:"notification"`
	}
	if err = json.Unmarshal(data, &input); err != nil {
		panic(err)
	}
	client, err := epay.NewClient(&epay.Config{PartnerID: input.Config["pid"], Key: input.Config["key"]}, input.Config["apiurl"])
	if err != nil {
		panic(err)
	}
	notify, err := url.Parse(input.Request["notify_url"])
	if err != nil {
		panic(err)
	}
	returned, err := url.Parse(input.Request["return_url"])
	if err != nil {
		panic(err)
	}
	target, fields, err := client.Purchase(&epay.PurchaseArgs{
		Type: "alipay", ServiceTradeNo: input.Request["out_trade_no"],
		Name: input.Request["name"], Money: input.Request["money"],
		Device: epay.PC, NotifyUrl: notify, ReturnUrl: returned,
	})
	if err != nil {
		panic(err)
	}
	verified, err := client.Verify(input.Notification)
	if err != nil {
		panic(err)
	}
	unsafe := map[string]string{"name": "a&b"}
	_, rejected := epay.GenerateParamsWithError(unsafe, input.Config["key"])
	result, err := json.Marshal(map[string]any{
		"url": target, "request": fields, "notify": verified.VerifyStatus,
		"rejectAmpersand": rejected != nil,
	})
	if err != nil {
		panic(err)
	}
	fmt.Println(string(result))
}
